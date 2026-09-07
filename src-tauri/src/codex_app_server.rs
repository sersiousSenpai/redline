// SPDX-License-Identifier: Apache-2.0
//! Minimal typed client for Codex's JSONL app-server protocol.
//!
//! This one-shot path is intentionally the first adapter: it gives tool-less
//! seats a real Codex execution path while the same wire primitives can be
//! promoted into a long-lived manager for conversational seats.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Resolve the absolute path to the `codex` binary — the same three-layer
/// discipline as `claude_proc::resolve_claude_bin`, and for a sharper reason.
///
/// The ChatGPT desktop app ships the *current* codex inside its bundle
/// (`/Applications/ChatGPT.app/Contents/Resources/codex`), while a machine
/// that once ran `brew install codex` still has an old standalone build first
/// on `$PATH`. That older build has no `app-server` and no `resume`, so it
/// cannot serve either the tool-less seat path or a plan session — and it
/// fails *quietly*, which is exactly the class of bug this app exists to kill.
/// So the bundle is probed ahead of the PATH-ish locations, and callers use
/// the absolute path rather than the bare word.
///
/// 1. `REDLINE_CODEX_BIN`, then the `redline.codexBin` setting — explicit
///    overrides beat every probe and are returned as given.
/// 2. Well-known install locations, app bundle first.
/// 3. An interactive login shell (`-ilc command -v codex`), for exotic
///    installs. Same TCC cost as the claude fallback, so same last place.
/// 4. The bare name.
pub fn resolve_codex_bin() -> String {
    if let Some(path) = std::env::var(crate::seat::ENV_CODEX_BIN)
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
    {
        return path;
    }
    if let Some(path) = crate::seat::codex_bin_override() {
        return path;
    }
    if let Some(path) = codex_install_locations().into_iter().find(|p| p.is_file()) {
        return path.to_string_lossy().into_owned();
    }
    // Cached in `binprobe` — same reasoning as the claude resolver: an
    // interactive login shell is the most expensive thing on this path, and
    // its answer only changes when the user's rc files do.
    crate::binprobe::login_shell_which("codex").unwrap_or_else(|| "codex".to_string())
}

/// Probed in order. The app bundle leads deliberately: when both it and a
/// standalone install exist, the bundle is the one that gets updated.
fn codex_install_locations() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from(CHATGPT_APP_CODEX)];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        // A per-user copy of the same bundle (~/Applications).
        paths.push(home.join("Applications/ChatGPT.app/Contents/Resources/codex"));
        paths.push(home.join(".local/bin/codex"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/codex"));
    paths.push(PathBuf::from("/usr/local/bin/codex"));
    paths
}

/// Where the ChatGPT desktop app keeps its bundled codex.
pub const CHATGPT_APP_CODEX: &str = "/Applications/ChatGPT.app/Contents/Resources/codex";

/// The top-level subcommands Redline depends on. `app-server` backs the
/// tool-less seat path; `resume` backs restoring a plan session; `exec` backs
/// every headless turn. A build missing any is *present but useless*, so
/// existence alone is not the question `codex_available` should answer.
const REQUIRED_SUBCOMMANDS: [&str; 3] = ["app-server", "resume", "exec"];

/// The `codex exec` subcommands Redline depends on: plan-comment discussion
/// threads run `exec fork` on the first turn and `exec resume` thereafter
/// (`fork.rs`).
///
/// Probed SEPARATELY from the list above, because `codex --help` cannot answer
/// it — it lists `exec` and stops. A build with a top-level `exec` but no
/// `exec fork` passes the outer banner and then fails at the first Discuss
/// click, which is the quiet-failure class this probe exists to kill.
const REQUIRED_EXEC_SUBCOMMANDS: [&str; 2] = ["fork", "resume"];

/// Does a `--help` banner list every one of `names` as a command? Pure, so both
/// capability rules are testable without a binary.
fn help_lists(help: &str, names: &[&str]) -> bool {
    names.iter().all(|name| {
        help.lines().any(|line| {
            let trimmed = line.trim_start();
            trimmed
                .strip_prefix(name)
                // "Commands:" entries are `<name><spaces><description>`; a
                // bare prefix match would accept `app-server-foo`.
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
        })
    })
}

/// Does this `codex --help` banner list every top-level subcommand Redline
/// needs?
pub fn help_lists_required_subcommands(help: &str) -> bool {
    help_lists(help, &REQUIRED_SUBCOMMANDS)
}

/// Does this `codex exec --help` banner list the non-interactive fork/resume
/// commands discussion threads run on?
pub fn exec_help_lists_required_subcommands(help: &str) -> bool {
    help_lists(help, &REQUIRED_EXEC_SUBCOMMANDS)
}

/// Is there a codex on this machine that can actually serve Redline?
///
/// Capability, not existence: the stale standalone build resolves fine and
/// then fails at the first `app-server`.
pub fn codex_available() -> bool {
    codex_capability(&resolve_codex_bin()).0
}

/// The one cache for "can this codex serve Redline", keyed by the binary's
/// modification identity. There used to be two paths to this answer — this
/// module's per-path map and `preflight::probe_codex`, which called the
/// uncached probe directly — so a boot that read the hook status and ran a
/// preflight spawned `codex --help` twice for the same binary.
static CAPABILITY: OnceLock<crate::binprobe::Cache<(bool, bool)>> = OnceLock::new();

/// `(usable, help_ran)` for one binary path. `help_ran` separates "answered
/// `--help` but is too old" from "did not run at all", which is the difference
/// between two different things to tell the user.
///
/// Cached per resolved path AND modification identity, not once per process: a
/// user who answers "Locate it…" with the right binary — or re-installs over
/// the same path — must see the answer change without restarting the app.
/// Concurrent callers share one child process (`binprobe::cached`).
pub fn codex_capability(bin: &str) -> (bool, bool) {
    crate::binprobe::cached(&CAPABILITY, bin, || codex_capability_uncached(bin))
}

/// Forget the cached capability for `bin`. The "Locate it…" fix path: picking
/// the same path again is the user saying "look again".
pub fn forget_codex_capability(bin: &str) {
    crate::binprobe::forget(&CAPABILITY, bin);
}

/// The actual `codex --help` children. Never call this directly from a surface
/// — go through `codex_capability` so the probe stays single-flight and cached.
///
/// TWO banners, because the capability question spans two levels: the top-level
/// one answers `app-server`/`resume`/`exec`, and `codex exec --help` answers
/// `exec fork`/`exec resume`. The second only runs when the first passed, so a
/// binary that isn't codex at all still costs one child.
fn codex_capability_uncached(bin: &str) -> (bool, bool) {
    let banner = |args: &[&str]| {
        std::process::Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let Some(help) = banner(&["--help"]) else {
        return (false, false);
    };
    if !help_lists_required_subcommands(&help) {
        return (false, true);
    }
    let exec_ok = banner(&["exec", "--help"])
        .is_some_and(|exec_help| exec_help_lists_required_subcommands(&exec_help));
    (exec_ok, true)
}

/// One row of `codex debug models`, projected down to what a picker needs.
///
/// The raw JSON is ~350 KB — every row carries the model's full system-prompt
/// template. Projecting here rather than in the frontend keeps that off the
/// IPC channel entirely.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub slug: String,
    pub display_name: String,
    pub description: String,
    /// The effort this model runs at when none is passed.
    pub default_effort: Option<String>,
    /// Every effort this model advertises. Per-model, and a different set
    /// from Claude's — `ultra` exists on the frontier models only.
    pub efforts: Vec<String>,
}

/// Parse the catalog, keeping only rows the CLI itself would list. `hide`
/// rows (`gpt-reserve`, `codex-auto-review`) are internal routing targets, not
/// things a user picks.
pub fn parse_model_catalog(text: &str) -> Result<Vec<CodexModel>, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let models = root
        .get("models")
        .and_then(Value::as_array)
        .ok_or("codex debug models returned no `models` array")?;
    Ok(models
        .iter()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|m| {
            let slug = m.get("slug").and_then(Value::as_str)?.to_string();
            Some(CodexModel {
                display_name: m
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(&slug)
                    .to_string(),
                description: m
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                default_effort: m
                    .get("default_reasoning_level")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                efforts: m
                    .get("supported_reasoning_levels")
                    .and_then(Value::as_array)
                    .map(|levels| {
                        levels
                            .iter()
                            .filter_map(|l| l.get("effort").and_then(Value::as_str))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                slug,
            })
        })
        .collect())
}

/// Ask the resolved binary what models it can run. Live, never a hardcoded
/// list: the catalog changes with every ChatGPT app update, and a stale list
/// would offer a model that fails at the first token.
pub async fn model_catalog() -> Result<Vec<CodexModel>, String> {
    let bin = resolve_codex_bin();
    let out = Command::new(&bin)
        .args(["debug", "models"])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("failed to run {bin} debug models: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{bin} debug models failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_model_catalog(&String::from_utf8_lossy(&out.stdout))
}

async fn send(stdin: &mut tokio::process::ChildStdin, value: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await.map_err(|e| e.to_string())
}

fn response_result(value: &Value, id: u64) -> Option<Result<Value, String>> {
    (value.get("id").and_then(Value::as_u64) == Some(id)).then(|| {
        if let Some(error) = value.get("error") {
            Err(error.to_string())
        } else {
            Ok(value.get("result").cloned().unwrap_or(Value::Null))
        }
    })
}

fn agent_text(value: &Value) -> Option<&str> {
    value.pointer("/params/delta").and_then(Value::as_str)
        .or_else(|| value.pointer("/params/item/text").and_then(Value::as_str))
        .or_else(|| value.pointer("/params/item/content/0/text").and_then(Value::as_str))
}

/// One Codex turn, driven to completion.
///
/// Returns the reply AND the turn's meter. The meter is mostly provenance:
/// Codex reports no usage on any shape captured so far, so its numbers are
/// usually zero and its model is the configured one — see
/// `meter::from_codex_turn` for why that is still worth carrying.
pub async fn run_one_shot(
    cwd: &Path,
    prompt: &str,
    model: Option<&str>,
) -> Result<(String, crate::meter::TurnMeter), String> {
    let bin = resolve_codex_bin();
    let mut child = Command::new(&bin)
        .arg("app-server")
        .current_dir(cwd)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn().map_err(|e| format!("failed to spawn codex app-server ({bin}): {e}"))?;
    let mut stdin = child.stdin.take().ok_or("codex stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("codex stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();

    send(&mut stdin, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"redline","version":env!("CARGO_PKG_VERSION")}}})).await?;
    let init = loop {
        let line = lines.next_line().await.map_err(|e| e.to_string())?.ok_or("codex app-server exited during initialize")?;
        let value: Value = serde_json::from_str(&line).map_err(|e| format!("invalid app-server JSON: {e}"))?;
        if let Some(result) = response_result(&value, 1) { break result?; }
    };
    let _ = init;
    send(&mut stdin, json!({"jsonrpc":"2.0","method":"initialized","params":{}})).await?;
    let mut thread_params = json!({"cwd": cwd, "approvalPolicy":"never", "sandbox":"read-only"});
    if let Some(model) = model.filter(|m| !m.trim().is_empty()) { thread_params["model"] = json!(model); }
    send(&mut stdin, json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":thread_params})).await?;
    let thread_id = loop {
        let line = lines.next_line().await.map_err(|e| e.to_string())?.ok_or("codex app-server exited before thread start")?;
        let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if let Some(result) = response_result(&value, 2) {
            let result = result?;
            break result.pointer("/thread/id").or_else(|| result.get("threadId"))
                .and_then(Value::as_str).ok_or("thread/start returned no thread id")?.to_string();
        }
    };
    send(&mut stdin, json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":thread_id,"input":[{"type":"text","text":prompt}]}})).await?;
    let mut text = String::new();
    // Provenance even if the turn never reports usage: the badge should read
    // the model whatever the protocol says (or doesn't).
    let mut meter = crate::meter::from_codex_turn(&Value::Null, model);
    let _ = &meter;
    loop {
        let line = lines.next_line().await.map_err(|e| e.to_string())?.ok_or("codex app-server exited before turn completion")?;
        let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        if method.contains("agentMessage") && method.ends_with("delta") {
            if let Some(delta) = agent_text(&value) { text.push_str(delta); }
        } else if method == "item/completed" && text.is_empty() {
            if let Some(final_text) = agent_text(&value) { text.push_str(final_text); }
        } else if method == "turn/completed" {
            // Whatever this carries, the ONE accounting rule reads it.
            meter = crate::meter::from_codex_turn(&value, model);
            break;
        } else if value.get("id").is_some() && value.get("method").is_some() {
            // A tool-less, read-only turn should never request approval. Deny
            // defensively so an unexpected server request cannot hang Redline.
            let id = value["id"].clone();
            send(&mut stdin, json!({"jsonrpc":"2.0","id":id,"result":{"decision":"decline"}})).await?;
        }
    }
    let _ = child.kill().await;
    if text.trim().is_empty() {
        Err("codex ended without producing a response".into())
    } else {
        Ok((text, meter))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn required_subcommands_gate_on_the_real_banners() {
        // The 0.149 bundle lists both; the 0.24 brew build lists neither.
        let current = "Commands:\n  exec              Run Codex non-interactively\n  app-server        [experimental] Run the app server\n  resume            Resume a previous interactive session\n";
        let stale = "Commands:\n  exec    Run Codex non-interactively\n  login   Manage login\n";
        assert!(help_lists_required_subcommands(current));
        assert!(!help_lists_required_subcommands(stale));
        // A longer name that merely starts with ours must not satisfy it.
        assert!(!help_lists_required_subcommands(
            "Commands:\n  app-server-remote  x\n  resume  y\n  exec  z\n"
        ));
    }

    /// `codex --help` stops at `exec` — it never names `exec fork`. A build
    /// with the outer command but not the inner one passes the top banner and
    /// then fails at the first Discuss click on a Codex plan, so the inner
    /// banner is probed on its own.
    #[test]
    fn exec_subcommands_are_gated_on_the_inner_banner() {
        let current = "Commands:\n  resume  Resume a previous session by id\n  fork    Fork a previous session by id into a new session\n  review  Run a code review\n";
        assert!(exec_help_lists_required_subcommands(current));
        // The shape that motivated this probe: exec exists, fork does not.
        let no_fork = "Commands:\n  resume  Resume a previous session by id\n  help    Print this message\n";
        assert!(!exec_help_lists_required_subcommands(no_fork));
        // Neither does the top-level banner answer the question on its own.
        let top_level = "Commands:\n  exec  Run Codex non-interactively\n  app-server  x\n  resume  y\n";
        assert!(help_lists_required_subcommands(top_level));
        assert!(!exec_help_lists_required_subcommands(top_level));
        // Same prefix discipline as the outer list.
        assert!(!exec_help_lists_required_subcommands(
            "Commands:\n  fork-remote  x\n  resume  y\n"
        ));
    }

    #[test]
    fn the_app_bundle_is_probed_before_the_stale_path_installs() {
        let order = codex_install_locations();
        let bundle = order
            .iter()
            .position(|p| p.to_string_lossy().contains("ChatGPT.app"))
            .expect("the app bundle must be a candidate");
        let brew = order
            .iter()
            .position(|p| p.ends_with("opt/homebrew/bin/codex"))
            .expect("homebrew must remain a candidate");
        assert!(bundle < brew, "the bundle build must win over the brew one");
    }

    #[test]
    fn model_catalog_keeps_listed_rows_and_their_efforts() {
        let raw = r#"{"models":[
          {"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol","description":"Frontier.",
           "default_reasoning_level":"low","visibility":"list",
           "supported_reasoning_levels":[{"effort":"low"},{"effort":"ultra"}],
           "base_instructions":"a very long system prompt"},
          {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide",
           "supported_reasoning_levels":[{"effort":"low"}]}
        ]}"#;
        let models = parse_model_catalog(raw).unwrap();
        assert_eq!(models.len(), 1, "hidden rows are not pickable");
        assert_eq!(models[0].slug, "gpt-5.6-sol");
        assert_eq!(models[0].default_effort.as_deref(), Some("low"));
        assert_eq!(models[0].efforts, vec!["low", "ultra"]);
    }

    #[test]
    fn model_catalog_refuses_junk_rather_than_guessing() {
        assert!(parse_model_catalog("not json").is_err());
        assert!(parse_model_catalog("{}").is_err());
        // A row without a slug is unusable, but must not sink the whole list.
        let mixed = r#"{"models":[{"visibility":"list"},{"slug":"m","visibility":"list"}]}"#;
        assert_eq!(parse_model_catalog(mixed).unwrap().len(), 1);
    }

    #[test]
    fn recognizes_rpc_responses_and_agent_text() {
        assert_eq!(response_result(&json!({"id":2,"result":{"ok":true}}), 2).unwrap().unwrap()["ok"], true);
        assert_eq!(agent_text(&json!({"params":{"delta":"hello"}})), Some("hello"));
    }
}
