// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `redline-mcp` — a thin stdio MCP proxy that ships with Redline core.
//!
//! An **external** `claude` session (one Redline didn't spawn) installs this
//! binary via a `~/.claude.json` snippet and gains read-only tools over the
//! user's Redline memory: `query_prompts`, `session_history`, `memory_tree`,
//! `stats`. Each tool call is forwarded as a plain localhost GET to Redline's
//! running daemon (`/v1/context/*`, `/v1/memory/*`) — so this process holds no
//! data, binds nothing, and only works while Redline is up.
//!
//! Redline's *internal* agents never use this: they keep `--strict-mcp-config`
//! and reach the same routes over the curl bridge. The request→route→response
//! logic lives in this crate's lib (unit-tested there); this binary is only
//! the stdio transport + the reqwest call.

use std::io::{BufRead, Write};
use std::time::Duration;

use redline_mcp::{handle_message, DEFAULT_DAEMON_ADDR};

fn main() {
    let addr = std::env::var("REDLINE_DAEMON_ADDR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_DAEMON_ADDR.to_string());
    let base = format!("http://{addr}");
    // All five facade tools ride open read-only routes today, so no token is
    // required — but forward one if the environment carries it, so this
    // binary survives the planned second-pass tokenization of reads.
    let token = std::env::var("REDLINE_DAEMON_TOKEN")
        .ok()
        .filter(|s| !s.trim().is_empty());

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("failed to build the http client");

    // The injected fetcher: one synchronous localhost GET per tool call.
    let http_get = move |path: &str, params: &[(String, String)]| -> Result<String, String> {
        let base_url = format!("{base}{path}");
        // Build a properly percent-encoded URL (avoids relying on the blocking
        // RequestBuilder's query helper, whose availability varies by version).
        let url = reqwest::Url::parse_with_params(
            &base_url,
            params.iter().map(|(k, v)| (k.as_str(), v.as_str())),
        )
        .map_err(|e| e.to_string())?;
        let mut req = client.get(url);
        if let Some(t) = &token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {status}: {text}"));
        }
        Ok(text)
    };

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // ignore non-JSON noise on the transport
        };
        if let Some(resp) = handle_message(&msg, &http_get) {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{}", serde_json::to_string(&resp).unwrap_or_default());
            let _ = out.flush();
        }
    }
}
