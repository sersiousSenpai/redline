// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The MCP snippet the settings surface offers external sessions.
//!
//! Since Session E1 of the Polis extraction the daemon serves the Model
//! Context Protocol itself: `polis_mcp::http_service` is nested at `/mcp`
//! (streamable HTTP, loopback, the read tools over the same `MemoryApi` the
//! routes use). An external `claude` session adds it with one command and no
//! binary — the `redline-mcp` stdio proxy that this module once pointed at is
//! retired. Only the snippet generator stays here: it belongs to the app's
//! settings UI.

use serde_json::json;

/// Where the daemon serves MCP.
pub const MCP_URL: &str = "http://127.0.0.1:7676/mcp";

/// The `~/.claude.json` shape (`type: http`), pretty-printed so it pastes.
pub fn claude_config_snippet() -> String {
    let v = json!({
        "mcpServers": {
            "redline": {
                "type": "http",
                "url": MCP_URL
            }
        }
    });
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

/// The one-liner that writes the same thing.
pub fn claude_add_command() -> String {
    format!("claude mcp add --transport http redline {MCP_URL}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn snippet_and_command_name_the_daemon_mount_and_no_binary() {
        let snip = claude_config_snippet();
        let v: Value = serde_json::from_str(&snip).unwrap();
        assert_eq!(v["mcpServers"]["redline"]["type"], "http");
        assert_eq!(v["mcpServers"]["redline"]["url"], MCP_URL);
        assert!(v["mcpServers"]["redline"].get("command").is_none(), "no binary to point at");
        assert_eq!(claude_add_command(), "claude mcp add --transport http redline http://127.0.0.1:7676/mcp");
        assert!(MCP_URL.starts_with("http://127.0.0.1:7676/"), "loopback, the daemon's own address");
    }
}
