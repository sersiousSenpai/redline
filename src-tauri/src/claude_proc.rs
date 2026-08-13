// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Shared plumbing for the headless `claude` child processes that back both
//! the per-comment discussion forks (`fork.rs`) and the browser's browse agent
//! (`browse.rs`): resolving the `claude` binary path, building a spawn-ready
//! `Command` with a usable PATH, and classifying `--output-format stream-json`
//! lines. All pure / side-effect-free except the binary probe, and unit-tested
//! against captured stream-json fixtures.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::Value;
use tokio::process::Command;

/// Resolve the absolute path to the `claude` binary. A Finder-launched macOS
/// app gets a minimal PATH with no shell rc, so `Command::new("claude")` can
/// fail even though `claude` works in a terminal. Three layers:
///
/// 1. Probe well-known install locations directly (native installer, nvm,
///    pnpm, bun, homebrew). Cheap, and touches no TCC-protected paths.
/// 2. Ask an *interactive* login shell (`-ilc`) — zsh sources `~/.zshrc` only
///    for interactive shells, which is where exotic installs put their PATH
///    lines. Interactive rcs may print banners, so only an output line that
///    is an existing file is accepted. This runs the user's full rc as a
///    child of Redline, and macOS attributes its file access to Redline
///    (TCC permission prompts) — which is why it is the fallback, not the
///    first probe.
/// 3. Fall back to the bare name (correct when launched from a terminal).
pub fn resolve_claude_bin() -> String {
    // 0. Explicit overrides beat every probe: the REDLINE_CLAUDE_BIN env var,
    //    then the settings-surface path (seat::claude_bin_override). Both are
    //    returned as-given — a wrong path fails loudly at spawn, which beats
    //    silently probing past a user's explicit choice.
    if let Some(path) = std::env::var(crate::seat::ENV_CLAUDE_BIN)
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
    {
        return path;
    }
    if let Some(path) = crate::seat::claude_bin_override() {
        return path;
    }
    if let Some(path) = known_install_locations().into_iter().find(|p| p.is_file()) {
        return path.to_string_lossy().into_owned();
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    std::process::Command::new(&shell)
        .args(["-ilc", "command -v claude"])
        // An interactive rc that reads stdin must hit EOF, not hang.
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| Path::new(line).is_file())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "claude".to_string())
}

/// Well-known `claude` install locations to probe when the shell can't tell
/// us. nvm versions are checked newest-first (lexicographic, close enough —
/// any hit is a working binary).
fn known_install_locations() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        paths.push(home.join(".claude/local/claude")); // claude migrate-installer
        paths.push(home.join(".local/bin/claude")); // native installer
        paths.push(home.join("Library/pnpm/claude")); // pnpm global
        paths.push(home.join(".bun/bin/claude")); // bun global
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            versions.sort();
            paths.extend(versions.into_iter().rev().map(|v| v.join("bin/claude")));
        }
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/claude"));
    paths.push(PathBuf::from("/usr/local/bin/claude"));
    paths
}

/// A `tokio::process::Command` for `claude_bin` with PATH prepended with the
/// binary's own directory. A Dock-launched app passes a minimal PATH to
/// children; an `#!/usr/bin/env node` shebang (npm installs) needs the `node`
/// that lives alongside `claude` to be findable. Every spawn also carries the
/// per-boot daemon token in the environment — that's how an agent's curl to a
/// protected `/v1` route authenticates. curl imports the variable itself
/// (`--variable %REDLINE_DAEMON_TOKEN= --expand-header "Authorization: Bearer
/// {{REDLINE_DAEMON_TOKEN}}"`, curl >= 8.3) rather than letting the shell
/// expand it, which the agent bash sandbox would reject; the flags sit after
/// the URL so the pre-authorized allow-prefix rules still match. See `auth.rs`.
pub fn claude_command(claude_bin: &str) -> Command {
    let mut cmd = Command::new(claude_bin);
    if let Some(bin_dir) = Path::new(claude_bin).parent().filter(|p| p.is_dir()) {
        let inherited = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}:{inherited}", bin_dir.display()));
    }
    cmd.env(crate::auth::ENV_DAEMON_TOKEN, crate::auth::daemon_token());
    cmd
}

/// `claude_command` with the seat's binary override applied: the seat's own
/// `binaryPath`, else the global settings override, else the caller's cached
/// `resolve_claude_bin()` result. Checked at every spawn (not just at cache
/// time) so a settings change takes effect without a relaunch.
pub fn claude_command_for_seat(seat: &str, default_bin: &str) -> Command {
    match crate::seat::binary_for(seat) {
        Some(bin) => claude_command(&bin),
        None => claude_command(default_bin),
    }
}

/// The `--tools` list every headless Redline agent spawns with. Passing
/// `--tools` RESTRICTS the CLI's built-in set — anything unlisted is stripped,
/// including the built-in `Skill` tool. Without `Skill` the init handshake
/// still *lists* discovered skills, but the agent has no tool to load a
/// skill's body, so every "follow the X skill" prompt line is silently a
/// no-op (verified empirically on claude CLI 2.1.222). Keep `Skill` here;
/// write/plan tools (`Edit`/`Write`/`ExitPlanMode`) stay out.
pub const HEADLESS_TOOLS: &str = "Read,Grep,Glob,WebFetch,WebSearch,Bash,Skill";

/// The INVARIANT argv block every headless bridge spawn shares: stream-json
/// with partial messages, the `HEADLESS_TOOLS` tool surface, the localhost
/// curl allow (three quoting variants — see `browse.rs` for why all three
/// prefix rules are required), with MCP stripped. ONE canonical, deterministic
/// ordering, defined once: the CLI sees a byte-stable flag block regardless of
/// which surface spawned it, and the per-spawn variables (prompt, seat flags,
/// `--resume`) ride outside it. `bridge_args` and the `browse_send`/
/// `mission_send` spawn sites all consume this const, so the block cannot
/// drift between call sites — never inline a copy.
pub const BRIDGE_INVARIANT_ARGS: [&str; 15] = [
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    "default",
    "--tools",
    HEADLESS_TOOLS,
    "--allowedTools",
    "WebSearch",
    "WebFetch",
    "Bash(curl -s http://127.0.0.1:7676/*)",
    "Bash(curl -s 'http://127.0.0.1:7676/*)",
    "Bash(curl -s \"http://127.0.0.1:7676/*)",
    "--strict-mcp-config",
];

/// The standard arg vector for a headless *browser-bridge* `claude` turn:
/// `-p <prompt>` + the canonical `BRIDGE_INVARIANT_ARGS` block. `seat` tags
/// the spawn with its Agent Seat, appending any configured
/// `--model`/`--effort`/`--fallback-model` flags (see `seat.rs`). Appends
/// `--resume <sid>` when resuming a prior session. Shared by the browse
/// consult path and the linked-discussion agent so the tool surface can't
/// drift between them.
pub fn bridge_args(seat: &str, prompt: String, prior_session: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec!["-p".to_string(), prompt];
    args.extend(BRIDGE_INVARIANT_ARGS.iter().map(|s| s.to_string()));
    args.extend(crate::seat::flag_args(seat));
    if let Some(sid) = prior_session {
        args.push("--resume".to_string());
        args.push(sid.to_string());
    }
    args
}

/// Refuse a FINAL argv that could escalate a read-only headless pass into a
/// write-capable one. `bridge_args` pins `--permission-mode default` and the
/// no-write `HEADLESS_TOOLS` surface in its invariant block, but a seat's
/// user-configured `extra_flags` are appended AFTER that block and the CLI
/// lets the LAST occurrence of a repeated flag win — so a seat tweak could
/// smuggle `--permission-mode bypassPermissions`/`acceptEdits`,
/// `--dangerously-skip-permissions`, or an extra `--tools`/`--allowedTools`
/// value naming `Edit`/`Write`/`NotebookEdit`/`ExitPlanMode` past a guard
/// that only greps for the literal `acceptEdits`. This inspects EVERY
/// occurrence of the escalation-capable flags (both `--flag value` and
/// `--flag=value` spellings) and refuses on the first hit, naming it.
/// Shared by the intake-triage and moot spawn sites; always call it on the
/// FINAL argv, after seat flags are appended. Fail-closed by design: a
/// false refusal costs a spawn, a false pass costs the read-only law.
pub fn assert_read_only_argv(args: &[String]) -> Result<(), String> {
    /// A `--tools`/`--allowedTools` value token that names a write/plan tool.
    /// Substring match per comma token: `NotebookEdit`/`MultiEdit` are caught
    /// by `Edit`, and a pattern form like `Write(*)` is caught by `Write`.
    fn write_tool_in(value: &str) -> Option<&str> {
        value.split(',').map(str::trim).find(|token| {
            ["Edit", "Write", "ExitPlanMode"]
                .iter()
                .any(|w| token.contains(w))
        })
    }
    let mut i = 0;
    while i < args.len() {
        let (flag, inline_val) = match args[i].split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v)),
            _ => (args[i].as_str(), None),
        };
        match flag {
            "--dangerously-skip-permissions" => {
                return Err("`--dangerously-skip-permissions` is in the argv".to_string());
            }
            "--permission-mode" => {
                let val = match inline_val {
                    Some(v) => Some(v.to_string()),
                    None => {
                        i += 1;
                        args.get(i).cloned()
                    }
                };
                match val.as_deref().map(str::trim) {
                    Some("default") => {}
                    Some(v) => {
                        return Err(format!(
                            "`--permission-mode {v}` would override the pinned `default` mode"
                        ));
                    }
                    None => {
                        return Err("`--permission-mode` was passed with no value".to_string());
                    }
                }
            }
            "--tools" | "--allowedTools" | "--allowed-tools" => {
                if let Some(v) = inline_val {
                    if let Some(tool) = write_tool_in(v) {
                        return Err(format!("`{flag}` names the write tool `{tool}`"));
                    }
                } else {
                    // Both flags accept a run of space-separated values —
                    // scan until the next `--flag` so a value appended late
                    // in the run is still seen.
                    while i + 1 < args.len() && !args[i + 1].starts_with("--") {
                        i += 1;
                        if let Some(tool) = write_tool_in(&args[i]) {
                            return Err(format!("`{flag}` names the write tool `{tool}`"));
                        }
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    Ok(())
}

/// A first-turn prompt fragment that makes a browse or linked agent aware of the
/// active research **mission**, when one is running. Both the per-tab page
/// discussion and the linked (spanning) discussion can run inside a mission
/// workspace, but neither is told what the user is researching — so they answer
/// blind to the goal. This bakes the goal in so they orient their help toward it.
/// The mission orchestrator (`mission.rs`) embeds the goal natively and needs
/// none of this. Returns an empty string when no mission is active or the goal is
/// blank, so callers can push it unconditionally.
pub fn mission_context_block(mission: Option<(&str, &str)>) -> String {
    let Some((title, goal)) = mission else {
        return String::new();
    };
    let goal = goal.trim();
    if goal.is_empty() {
        return String::new();
    }
    let mut p = String::from(
        "A research MISSION is currently active — the user is working toward one \
         goal across their browser tabs, and this discussion is part of that \
         research. Keep your help oriented to the mission's goal.\n\n",
    );
    let title = title.trim();
    if !title.is_empty() {
        p.push_str(&format!("Mission: {title}\n"));
    }
    p.push_str("The mission's goal, in the user's words:\n\n");
    for line in goal.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p.push_str(
        "\nThe user may refine the goal or pin more findings as they browse, so \
         re-read the current mission and its pins whenever you need them (already \
         permitted — no approval needed):\n  \
         curl -s http://127.0.0.1:7676/v1/mission/active\n  \
         curl -s http://127.0.0.1:7676/v1/mission/findings\n\n",
    );
    p
}

/// The terminal outcome of one headless turn, collected silently (no UI
/// events) — the consult path's stream driver. Used by the Companion's
/// `/v1/global/consult` fan-out, where the digest is returned inline to a
/// blocking curl rather than streamed to a pane.
pub struct TurnOutcome {
    pub session: Option<String>,
    pub final_text: Option<String>,
    pub errored: Option<String>,
    pub saw_json: bool,
    pub stderr_text: String,
}

/// Drain a spawned `claude`'s stdout/stderr to completion and classify the
/// result. stderr is drained concurrently so a full pipe can't block the child.
pub async fn collect_turn(
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
) -> TurnOutcome {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut text = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            text.push_str(&line);
            text.push('\n');
        }
        text
    });
    let mut lines = BufReader::new(stdout).lines();
    let mut out = TurnOutcome {
        session: None,
        final_text: None,
        errored: None,
        saw_json: false,
        stderr_text: String::new(),
    };
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        out.saw_json = true;
        match classify_line(&v) {
            StreamLine::Init(sid) => out.session = Some(sid),
            StreamLine::Final { text, session_id } => {
                if session_id.is_some() {
                    out.session = session_id;
                }
                out.final_text = Some(text);
            }
            StreamLine::Failed(msg) => out.errored = Some(msg),
            StreamLine::Delta(_) | StreamLine::Ignore => {}
        }
    }
    out.stderr_text = stderr_task.await.unwrap_or_default();
    out
}

/// What one `--output-format stream-json` line means to a process reader.
/// See `docs/protocol-verification.md` Experiment (i) for the captured shapes.
#[derive(Debug, PartialEq)]
pub enum StreamLine {
    /// `system`/`init` — carries the session id.
    Init(String),
    /// A `text_delta` chunk of the assistant's reply.
    Delta(String),
    /// `result` success — the authoritative final text + session id.
    Final {
        text: String,
        session_id: Option<String>,
    },
    /// `result` with `is_error` — a failed turn.
    Failed(String),
    /// Everything else (status, hook events, the cumulative `assistant`
    /// snapshot, thinking `signature_delta`s, …) — produces no output.
    Ignore,
}

/// Classify a single parsed JSONL line. Pure — unit-tested against captured
/// fixtures. The `text_delta` discrimination is load-bearing: thinking blocks
/// also stream `content_block_delta`s, but with `delta.type == "signature_delta"`.
pub fn classify_line(v: &Value) -> StreamLine {
    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            match v.get("session_id").and_then(Value::as_str) {
                Some(sid) => StreamLine::Init(sid.to_string()),
                None => StreamLine::Ignore,
            }
        }
        Some("stream_event") => {
            let event = &v["event"];
            let is_text_delta = event.get("type").and_then(Value::as_str)
                == Some("content_block_delta")
                && event
                    .get("delta")
                    .and_then(|d| d.get("type"))
                    .and_then(Value::as_str)
                    == Some("text_delta");
            if is_text_delta {
                match event["delta"].get("text").and_then(Value::as_str) {
                    Some(text) if !text.is_empty() => StreamLine::Delta(text.to_string()),
                    _ => StreamLine::Ignore,
                }
            } else {
                StreamLine::Ignore
            }
        }
        Some("result") => {
            let session_id = v
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if v.get("is_error").and_then(Value::as_bool) == Some(true) {
                let msg = v
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| v.get("subtype").and_then(Value::as_str))
                    .unwrap_or("claude reported an error")
                    .to_string();
                StreamLine::Failed(msg)
            } else {
                let text = v
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                StreamLine::Final { text, session_id }
            }
        }
        _ => StreamLine::Ignore,
    }
}

/// The tool calls carried by one parsed stream line, as `(name, input)`.
///
/// The complete call — name AND arguments — arrives on the `assistant` message
/// line. The `stream_event` `content_block_start` for a tool_use fires earlier
/// but with an empty `input` (the arguments stream in as `input_json_delta`
/// afterwards), so it can say *that* a tool ran but never *which* URL, which is
/// the only part worth showing a waiting user.
pub fn tool_uses(v: &Value) -> Vec<(String, Value)> {
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter_map(|b| {
                    let name = b.get("name").and_then(Value::as_str)?;
                    Some((
                        name.to_string(),
                        b.get("input").cloned().unwrap_or(Value::Null),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A short, human phrase for a retrieval tool call — what to show a user who
/// is otherwise watching a blank elapsed ticker until the first answer token.
///
/// Deliberately about the RECORD, not the plumbing: "searching the lake" is
/// what the user recognizes; `Bash(curl -s http://127.0.0.1:7676/…)` is not.
/// Anything unrecognized falls back to the bare tool name rather than a
/// misleading guess.
pub fn retrieval_status_label(name: &str, input: &Value) -> String {
    // Every bridge read is a `curl` in a Bash call; the URL is the signal.
    let text = input
        .get("command")
        .or_else(|| input.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let phrase = if text.contains("/v1/memory/answer-pack") {
        "searching your memory…"
    } else if text.contains("/v1/memory/tree") {
        "reading the catalog…"
    } else if text.contains("/v1/memory/node") {
        "opening a class…"
    } else if text.contains("/v1/context/browse/search") {
        "searching pages…"
    } else if text.contains("/v1/context/prompts") || text.contains("/v1/memory/prompts") {
        "searching the lake…"
    } else if text.contains("/v1/context/sessions") {
        "reading a plan's history…"
    } else if text.contains("/v1/context/threads") || text.contains("/v1/context/tree") {
        "following a thread…"
    } else if text.contains("/v1/context/stats") {
        "counting the record…"
    } else {
        return match name {
            "Skill" => "loading a skill…".to_string(),
            "WebSearch" => "searching the web…".to_string(),
            "WebFetch" => "fetching a page…".to_string(),
            other => format!("{other}…"),
        };
    };
    phrase.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> StreamLine {
        classify_line(&serde_json::from_str::<Value>(line).unwrap())
    }

    /// The label map is what a waiting user actually reads, so it is asserted
    /// route by route.
    #[test]
    fn retrieval_labels_name_the_record_not_the_plumbing() {
        let bash = |cmd: &str| serde_json::json!({ "command": cmd });
        let cases = [
            ("curl -s 'http://127.0.0.1:7676/v1/memory/answer-pack?q=loop'", "searching your memory…"),
            ("curl -s http://127.0.0.1:7676/v1/memory/tree", "reading the catalog…"),
            ("curl -s http://127.0.0.1:7676/v1/memory/node/root-loop", "opening a class…"),
            ("curl -s 'http://127.0.0.1:7676/v1/context/prompts?q=x'", "searching the lake…"),
            ("curl -s 'http://127.0.0.1:7676/v1/context/browse/search?q=x'", "searching pages…"),
            ("curl -s http://127.0.0.1:7676/v1/context/stats", "counting the record…"),
            ("curl -s http://127.0.0.1:7676/v1/context/sessions/s1/history", "reading a plan's history…"),
        ];
        for (cmd, want) in cases {
            assert_eq!(retrieval_status_label("Bash", &bash(cmd)), want, "for {cmd}");
        }
        // Non-bridge tools fall back to something honest.
        assert_eq!(retrieval_status_label("Skill", &Value::Null), "loading a skill…");
        assert_eq!(retrieval_status_label("Grep", &Value::Null), "Grep…");
    }

    /// Tool calls are read off the `assistant` line, where the arguments are
    /// complete — not off `content_block_start`, where `input` is still empty.
    #[test]
    fn tool_uses_reads_complete_calls_off_the_assistant_line() {
        let line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "Let me look." },
                { "type": "tool_use", "name": "Bash",
                  "input": { "command": "curl -s http://127.0.0.1:7676/v1/memory/tree" } }
            ]}
        });
        let calls = tool_uses(&line);
        assert_eq!(calls.len(), 1, "text blocks are not tool calls");
        assert_eq!(calls[0].0, "Bash");
        assert_eq!(
            retrieval_status_label(&calls[0].0, &calls[0].1),
            "reading the catalog…"
        );
        // A partial-message line carries no complete call.
        let partial = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_start",
                       "content_block": { "type": "tool_use", "name": "Bash", "input": {} } }
        });
        assert!(tool_uses(&partial).is_empty());
        // And a plain text turn has none either.
        assert!(tool_uses(&serde_json::json!({ "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "hi" }] } })).is_empty());
    }

    #[test]
    fn mission_context_block_empty_without_active_mission() {
        assert_eq!(mission_context_block(None), "");
        // A blank goal is treated as no mission.
        assert_eq!(mission_context_block(Some(("Title", "   "))), "");
    }

    #[test]
    fn mission_context_block_embeds_goal_and_reread_routes() {
        let b = mission_context_block(Some(("Breach page", "Draft my breach page")));
        assert!(b.contains("A research MISSION is currently active"));
        assert!(b.contains("Mission: Breach page"));
        assert!(b.contains("Draft my breach page"));
        // Re-read routes so a mid-conversation goal/pin change stays reachable.
        assert!(b.contains("/v1/mission/active"));
        assert!(b.contains("/v1/mission/findings"));
    }

    #[test]
    fn bridge_invariant_args_are_byte_stable_across_spawns() {
        // Two spawns with different variable inputs (prompt, resume) must
        // carry the IDENTICAL invariant flag block, contiguously, right after
        // the prompt — the deterministic argv prefix the CLI keys caching on.
        let a = bridge_args("companion", "ask about X".to_string(), None);
        let b = bridge_args("companion", "totally different".to_string(), Some("sid-9"));
        assert_eq!(a[0], "-p");
        assert_eq!(&a[2..2 + BRIDGE_INVARIANT_ARGS.len()], &BRIDGE_INVARIANT_ARGS[..]);
        assert_eq!(&b[2..2 + BRIDGE_INVARIANT_ARGS.len()], &BRIDGE_INVARIANT_ARGS[..]);
        // Canonical ordering facts the block must never lose: the tool
        // surface before the allow-list, MCP stripped last.
        assert_eq!(BRIDGE_INVARIANT_ARGS[7], HEADLESS_TOOLS);
        assert_eq!(BRIDGE_INVARIANT_ARGS[14], "--strict-mcp-config");
    }

    #[test]
    fn bridge_args_unconfigured_seat_adds_no_flags() {
        let args = bridge_args("companion", "hi".to_string(), None);
        assert!(!args.iter().any(|a| a == "--model"));
        assert!(!args.iter().any(|a| a == "--effort"));
        assert!(!args.iter().any(|a| a == "--fallback-model"));
    }

    #[test]
    fn bridge_args_carry_the_seats_model_and_effort_before_resume() {
        // The seat store is process-global and `seat::tests` clears it
        // wholesale, so hold the shared guard while configuring + asserting.
        let _guard = crate::seat::store_guard();
        crate::seat::set_seat_for_test(
            "voice",
            Some(crate::seat::SeatConfig {
                model: Some("sonnet".to_string()),
                effort: Some("medium".to_string()),
                ..Default::default()
            }),
        );
        let args = bridge_args("voice", "hi".to_string(), Some("sid-1"));
        let model_idx = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[model_idx + 1], "sonnet");
        let effort_idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[effort_idx + 1], "medium");
        // The resume tail must stay terminal (flags precede it).
        let resume_idx = args.iter().position(|a| a == "--resume").unwrap();
        assert!(model_idx < resume_idx && effort_idx < resume_idx);
        assert_eq!(args[resume_idx + 1], "sid-1");
        crate::seat::set_seat_for_test("voice", None);
    }

    /// The canonical invariant block, argv-shaped, without touching the
    /// process-global seat store (so these tests can't race `seat::tests`).
    fn canonical_argv() -> Vec<String> {
        let mut args: Vec<String> = vec!["-p".to_string(), "say hi".to_string()];
        args.extend(BRIDGE_INVARIANT_ARGS.iter().map(|s| s.to_string()));
        args
    }

    #[test]
    fn assert_read_only_argv_accepts_the_canonical_bridge_block() {
        assert!(assert_read_only_argv(&canonical_argv()).is_ok());
        // Restating the pinned default is harmless, not a refusal.
        let mut args = canonical_argv();
        args.extend(["--permission-mode".to_string(), "default".to_string()]);
        assert!(assert_read_only_argv(&args).is_ok());
    }

    #[test]
    fn assert_read_only_argv_refuses_every_smuggled_escalation() {
        // Each of these rides AFTER the invariant block — exactly where seat
        // `extra_flags` land, where a later flag wins in the CLI.
        let smuggles: Vec<Vec<&str>> = vec![
            vec!["--permission-mode", "bypassPermissions"],
            vec!["--permission-mode", "acceptEdits"],
            vec!["--permission-mode=bypassPermissions"],
            vec!["--permission-mode"], // trailing, valueless — fail closed
            vec!["--dangerously-skip-permissions"],
            vec!["--allowedTools", "Edit"],
            vec!["--allowedTools", "WebSearch", "Write(*)"],
            vec!["--allowedTools=NotebookEdit"],
            vec!["--tools", "Read,Grep,Edit"],
            vec!["--tools=Bash,ExitPlanMode"],
        ];
        for smuggle in smuggles {
            let mut args = canonical_argv();
            args.extend(smuggle.iter().map(|s| s.to_string()));
            assert!(
                assert_read_only_argv(&args).is_err(),
                "should refuse: {smuggle:?}"
            );
        }
    }

    #[test]
    fn classify_init_captures_session_id() {
        let line = r#"{"type":"system","subtype":"init","session_id":"fork-abc","tools":["Read"]}"#;
        assert_eq!(parse(line), StreamLine::Init("fork-abc".to_string()));
    }

    #[test]
    fn classify_text_delta_is_a_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}}"#;
        assert_eq!(parse(line), StreamLine::Delta("hello".to_string()));
    }

    #[test]
    fn classify_signature_delta_is_ignored() {
        // Thinking blocks stream content_block_delta with a signature_delta —
        // it must NOT render as assistant text.
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EtgEg...=="}}}"#;
        assert_eq!(parse(line), StreamLine::Ignore);
    }

    #[test]
    fn classify_assistant_snapshot_is_ignored() {
        // The cumulative `assistant` message would double-render against the
        // text deltas — it must be ignored.
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#;
        assert_eq!(parse(line), StreamLine::Ignore);
    }

    #[test]
    fn classify_result_success() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"final answer","session_id":"fork-abc"}"#;
        assert_eq!(
            parse(line),
            StreamLine::Final {
                text: "final answer".to_string(),
                session_id: Some("fork-abc".to_string()),
            },
        );
    }

    #[test]
    fn classify_result_error() {
        let line = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}"#;
        assert_eq!(parse(line), StreamLine::Failed("boom".to_string()));
    }

    #[test]
    fn classify_misc_events_ignored() {
        for line in [
            r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}"#,
            r#"{"type":"system","subtype":"status","status":"requesting"}"#,
            r#"{"type":"rate_limit_event"}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
        ] {
            assert_eq!(parse(line), StreamLine::Ignore, "should ignore: {line}");
        }
    }
}
