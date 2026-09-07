// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Driving a JSON-lines child process to completion: every stdout line that
//! parses is handed to the caller's fold, stderr is drained concurrently (a
//! full pipe must never block the child), and the exit status is waited for.
//! Shared by the two CLI backends.

use std::process::Stdio;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// What the drive returns beside the caller's folded state.
#[derive(Debug, Default)]
pub struct Drained {
    /// The stderr text, capped at `STDERR_CAP` bytes — enough to name the
    /// failure, not enough to swamp a log.
    pub stderr: String,
    /// Whether at least one stdout line parsed as JSON. `false` after a run
    /// means the binary answered in some other protocol (or not at all).
    pub saw_json: bool,
    pub exit_ok: bool,
}

pub const STDERR_CAP: usize = 2_000;

/// Spawn `cmd` with stdin closed and both pipes captured. A `NotFound` is
/// reported as such so the caller can turn it into "unavailable" rather than
/// "failed".
pub fn spawn(cmd: &mut Command) -> Result<Child, (bool, String)> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd.spawn().map_err(|e| (e.kind() == std::io::ErrorKind::NotFound, e.to_string()))
}

/// Read the child's stdout line by line, folding each JSON line through
/// `on_line`, until it exits.
pub async fn drive(mut child: Child, mut on_line: impl FnMut(&Value)) -> Drained {
    let mut out = Drained::default();
    let Some(stdout) = child.stdout.take() else {
        return out;
    };
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if text.len() < STDERR_CAP {
                    text.push_str(&line);
                    text.push('\n');
                }
            }
        }
        text
    });
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        out.saw_json = true;
        on_line(&v);
    }
    out.exit_ok = child.wait().await.map(|s| s.success()).unwrap_or(false);
    out.stderr = stderr_task.await.unwrap_or_default();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drives_json_lines_and_caps_stderr() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(
            "printf '{\"a\":1}\\nnot json\\n{\"a\":2}\\n'; printf 'warn\\n' 1>&2; exit 0",
        );
        let child = spawn(&mut cmd).unwrap();
        let mut seen = Vec::new();
        let d = drive(child, |v| seen.push(v["a"].as_i64().unwrap())).await;
        assert_eq!(seen, [1, 2], "the non-JSON line is skipped, not fatal");
        assert!(d.saw_json);
        assert!(d.exit_ok);
        assert_eq!(d.stderr.trim(), "warn");
    }

    #[tokio::test]
    async fn a_missing_binary_is_reported_as_not_found() {
        let mut cmd = Command::new("/nonexistent/polis-llm-test-binary");
        let err = spawn(&mut cmd).err().expect("no such binary");
        assert!(err.0, "NotFound is distinguished from other spawn failures");
    }
}
