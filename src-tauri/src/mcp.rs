// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! App-side remnant of the MCP integration: the copyable `~/.claude.json`
//! snippet the settings surface offers external `claude` sessions.
//!
//! The MCP protocol core (tool definitions, JSON-RPC dispatch) and the
//! `redline-mcp` proxy binary live in the `crates/redline-mcp` workspace
//! member — moved out so the proxy stops linking all of `redline_lib`
//! (~28 MB → ~2 MB; docs/perf-budget.md "Size budget"). Only this snippet
//! generator stays: it belongs to the app's settings UI, and keeping it here
//! means the app does not depend on the proxy crate (nor vice versa).

use serde_json::json;

/// The copyable `~/.claude.json` snippet an external session installs to reach
/// Redline's memory. `bin_path` is the absolute path to the `redline-mcp`
/// binary. Pretty JSON so it pastes cleanly.
pub fn claude_config_snippet(bin_path: &str) -> String {
    let v = json!({
        "mcpServers": {
            "redline": {
                "command": bin_path,
                "args": []
            }
        }
    });
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn snippet_is_valid_json_with_the_binary_path() {
        let snip = claude_config_snippet("/Applications/Redline.app/redline-mcp");
        let v: Value = serde_json::from_str(&snip).unwrap();
        assert_eq!(v["mcpServers"]["redline"]["command"], "/Applications/Redline.app/redline-mcp");
    }
}
