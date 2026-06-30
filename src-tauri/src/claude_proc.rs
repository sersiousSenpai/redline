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
/// that lives alongside `claude` to be findable.
pub fn claude_command(claude_bin: &str) -> Command {
    let mut cmd = Command::new(claude_bin);
    if let Some(bin_dir) = Path::new(claude_bin).parent().filter(|p| p.is_dir()) {
        let inherited = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}:{inherited}", bin_dir.display()));
    }
    cmd
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> StreamLine {
        classify_line(&serde_json::from_str::<Value>(line).unwrap())
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
