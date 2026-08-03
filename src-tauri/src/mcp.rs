// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! MCP (Model Context Protocol) server **core** for Redline's context access
//! (Phase 4). This module is the pure, testable heart of the `redline-mcp`
//! stdio proxy binary (`src/bin/redline-mcp.rs`): it turns a JSON-RPC message
//! into a response, delegating any actual data fetch to an injected `http_get`
//! closure that (in production) curls Redline's localhost daemon.
//!
//! The MCP server exists ONLY for **external** `claude` sessions — Redline's own
//! internal agents keep `--strict-mcp-config` and reach the same data over the
//! curl bridge (`/v1/context/*`, `/v1/memory/*`). Re-enabling MCP for internal
//! roles is deliberately rejected (plan Decision #1); this binary reopens no
//! such door — it is a read-only proxy an external session opts into, binding
//! nothing and adding no network op beyond the localhost GETs it forwards.
//!
//! Transport (handled by the binary): newline-delimited JSON-RPC 2.0 over
//! stdio. This module is transport-agnostic — it maps one parsed message to an
//! optional response value.

use serde_json::{json, Value};

/// The protocol version we advertise if the client doesn't pin one.
pub const DEFAULT_PROTOCOL_VERSION: &str = "2024-11-05";

/// Default daemon address the proxy forwards to (overridable via
/// `REDLINE_DAEMON_ADDR`). Kept in sync with `lib.rs::DAEMON_ADDR`.
pub const DEFAULT_DAEMON_ADDR: &str = "127.0.0.1:7676";

/// The four tools the proxy exposes, each a thin wrapper over one read-only
/// route. Returned by `tools/list` and used to validate `tools/call` names.
pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "query_prompts",
            "description": "Search the user's captured prompts (the Redline lake). Filter by session, mission, surface, project, a since-seq floor, and a free-text substring. Returns oldest-first prompt/decision items.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Only prompts from this plan session."},
                    "mission_id": {"type": "string", "description": "Only prompts captured under this mission."},
                    "surface": {"type": "string", "description": "Capture surface, e.g. pty_plan, browse, mission, voice."},
                    "project": {"type": "string", "description": "Absolute project path to scope to."},
                    "since_seq": {"type": "integer", "description": "Only events with ledger seq greater than this."},
                    "q": {"type": "string", "description": "Case-sensitive substring to match in the prompt body."},
                    "limit": {"type": "integer", "description": "Max items (1..200, default 200)."}
                }
            }
        },
        {
            "name": "session_history",
            "description": "Full history of one plan session: revision digests, comment threads, and the decision/curation ledger events tied to it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "The plan session id."}
                },
                "required": ["session_id"]
            }
        },
        {
            "name": "memory_tree",
            "description": "The user's ClassMemory catalog (the vectorless class tree over the lake), flat with link counts. Optionally scope to one root class or a project's seeded root.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "Scope to the root class bound to this project path."},
                    "root": {"type": "string", "description": "Scope to this class node id and its descendants."}
                }
            }
        },
        {
            "name": "stats",
            "description": "Aggregate counts over the lake: prompts per day, per surface, ledger events per kind, and linked items per class. Agent-facing insight, no UI.",
            "inputSchema": {"type": "object", "properties": {}}
        },
        {
            "name": "search_browsing",
            "description": "Lexical (BM25) full-text search over the user's browsing behavior — the pages they landed on, with a matched snippet per hit, best-first. Keyword-heavy and fuzzy; use for 'what pages has the user seen about X'. Distinct from query_prompts (their prompts) and memory_tree (their curated classes).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "q": {"type": "string", "description": "Free-text keywords to match against page content."},
                    "limit": {"type": "integer", "description": "Max hits (1..100, default 20)."}
                },
                "required": ["q"]
            }
        }
    ])
}

/// Map a `tools/call` (name + arguments) to a `(path, query-params)` pair for
/// the localhost GET, or an error string for an unknown tool. Pure — the actual
/// fetch is the caller's injected `http_get`.
pub fn route_for_tool(name: &str, args: &Value) -> Result<(String, Vec<(String, String)>), String> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    let i = |k: &str| {
        args.get(k).and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
        })
    };
    let mut params: Vec<(String, String)> = Vec::new();
    let push = |params: &mut Vec<(String, String)>, k: &str, v: Option<String>| {
        if let Some(v) = v.filter(|v| !v.is_empty()) {
            params.push((k.to_string(), v));
        }
    };
    match name {
        "query_prompts" => {
            push(&mut params, "session", s("session_id"));
            push(&mut params, "mission", s("mission_id"));
            push(&mut params, "surface", s("surface"));
            push(&mut params, "project", s("project"));
            push(&mut params, "q", s("q"));
            if let Some(seq) = i("since_seq") {
                params.push(("since_seq".into(), seq.to_string()));
            }
            if let Some(lim) = i("limit") {
                params.push(("limit".into(), lim.to_string()));
            }
            Ok(("/v1/context/prompts".to_string(), params))
        }
        "session_history" => {
            let id = s("session_id").filter(|v| !v.is_empty()).ok_or("session_history requires session_id")?;
            // Path segment; the caller URL-encodes.
            Ok((format!("/v1/context/sessions/{id}/history"), params))
        }
        "memory_tree" => {
            push(&mut params, "project", s("project"));
            push(&mut params, "root", s("root"));
            Ok(("/v1/memory/tree".to_string(), params))
        }
        "stats" => Ok(("/v1/context/stats".to_string(), params)),
        "search_browsing" => {
            push(&mut params, "q", s("q"));
            if let Some(lim) = i("limit") {
                params.push(("limit".into(), lim.to_string()));
            }
            Ok(("/v1/context/browse/search".to_string(), params))
        }
        other => Err(format!("unknown tool `{other}`")),
    }
}

/// Handle one parsed JSON-RPC message. Returns `Some(response)` for a request
/// and `None` for a notification (no id / `notifications/*`). `http_get(path,
/// params)` performs the localhost GET and returns the response body text.
pub fn handle_message<F>(msg: &Value, http_get: &F) -> Option<Value>
where
    F: Fn(&str, &[(String, String)]) -> Result<String, String>,
{
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let id = msg.get("id").cloned();

    // Notifications carry no id and expect no response.
    if id.is_none() || method.starts_with("notifications/") {
        return None;
    }
    let id = id.unwrap();

    match method {
        "initialize" => {
            let protocol = msg
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL_VERSION)
                .to_string();
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": protocol,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "redline", "version": env!("CARGO_PKG_VERSION") }
                }
            }))
        }
        "ping" => Some(json!({"jsonrpc": "2.0", "id": id, "result": {}})),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tool_definitions() }
        })),
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let (result_value, is_error) = match route_for_tool(name, &args) {
                Ok((path, qp)) => match http_get(&path, &qp) {
                    Ok(body) => (body, false),
                    Err(e) => (format!("Redline daemon error: {e}. Is Redline running?"), true),
                },
                Err(e) => (e, true),
            };
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{ "type": "text", "text": result_value }],
                    "isError": is_error
                }
            }))
        }
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("method not found: {method}") }
        })),
    }
}

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

    /// A stub daemon: records the last path/params and returns canned JSON.
    fn stub() -> impl Fn(&str, &[(String, String)]) -> Result<String, String> {
        move |path: &str, params: &[(String, String)]| {
            Ok(json!({ "path": path, "params": params }).to_string())
        }
    }

    #[test]
    fn tools_list_returns_the_expected_tools() {
        let msg = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let resp = handle_message(&msg, &stub()).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            ["query_prompts", "session_history", "memory_tree", "stats", "search_browsing"]
        );
    }

    #[test]
    fn search_browsing_routes_to_the_browse_search_endpoint() {
        let (path, params) =
            route_for_tool("search_browsing", &json!({"q": "clerk auth", "limit": 5})).unwrap();
        assert_eq!(path, "/v1/context/browse/search");
        assert!(params.contains(&("q".to_string(), "clerk auth".to_string())));
        assert!(params.contains(&("limit".to_string(), "5".to_string())));
    }

    #[test]
    fn initialize_echoes_protocol_and_names_the_server() {
        let msg = json!({"jsonrpc":"2.0","id":0,"method":"initialize",
            "params":{"protocolVersion":"2025-06-18"}});
        let resp = handle_message(&msg, &stub()).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(resp["result"]["serverInfo"]["name"], "redline");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
    }

    #[test]
    fn notifications_get_no_response() {
        let msg = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        assert!(handle_message(&msg, &stub()).is_none());
    }

    #[test]
    fn tools_call_proxies_query_prompts_with_mapped_params() {
        let msg = json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{
            "name":"query_prompts",
            "arguments":{"surface":"browse","q":"clerk","since_seq":5,"limit":10}
        }});
        let resp = handle_message(&msg, &stub()).unwrap();
        assert_eq!(resp["result"]["isError"], false);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let proxied: Value = serde_json::from_str(text).unwrap();
        assert_eq!(proxied["path"], "/v1/context/prompts");
        // The `q` argument maps to the route's `q`, `since_seq`/`limit` pass through.
        let params = proxied["params"].as_array().unwrap();
        assert!(params.contains(&json!(["surface", "browse"])));
        assert!(params.contains(&json!(["q", "clerk"])));
        assert!(params.contains(&json!(["since_seq", "5"])));
        assert!(params.contains(&json!(["limit", "10"])));
    }

    #[test]
    fn session_history_puts_the_id_in_the_path() {
        let (path, _) = route_for_tool("session_history", &json!({"session_id": "abc123"})).unwrap();
        assert_eq!(path, "/v1/context/sessions/abc123/history");
        assert!(route_for_tool("session_history", &json!({})).is_err());
    }

    #[test]
    fn unknown_tool_is_an_is_error_result_not_a_crash() {
        let msg = json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"rm_rf","arguments":{}}});
        let resp = handle_message(&msg, &stub()).unwrap();
        assert_eq!(resp["result"]["isError"], true);
    }

    #[test]
    fn unknown_method_yields_jsonrpc_error() {
        let msg = json!({"jsonrpc":"2.0","id":9,"method":"frobnicate"});
        let resp = handle_message(&msg, &stub()).unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn snippet_is_valid_json_with_the_binary_path() {
        let snip = claude_config_snippet("/Applications/Redline.app/redline-mcp");
        let v: Value = serde_json::from_str(&snip).unwrap();
        assert_eq!(v["mcpServers"]["redline"]["command"], "/Applications/Redline.app/redline-mcp");
    }
}
