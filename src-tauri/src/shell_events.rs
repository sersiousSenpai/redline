// SPDX-License-Identifier: Apache-2.0
//! Stable events shared by hosted Claude and Codex; no UI-specific parsing.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellEvent {
    pub seq: u64,
    pub kind: String,
    pub data: Value,
}
impl ShellEvent {
    pub fn new(kind: &str, data: Value) -> Self {
        Self {
            seq: 0,
            kind: kind.into(),
            data,
        }
    }
}
pub fn normalize(value: &Value) -> Vec<ShellEvent> {
    let mut events = Vec::new();
    match value["type"].as_str().unwrap_or("") {
        "stream_event" if value.pointer("/event/delta/type").and_then(Value::as_str) == Some("text_delta") => events.push(ShellEvent::new("delta", json!({"text":value["event"]["delta"]["text"]}))),
        "assistant" => {
            if let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array) { for block in blocks {
                if block["type"] == "tool_use" { events.push(ShellEvent::new("tool", json!({"id":block["id"],"name":block["name"],"input":block["input"],"parentId":value["parent_tool_use_id"]}))); }
            } }
        }
        "user" => {
            let content = &value["message"]["content"];
            if let Some(blocks) = content.as_array() { for block in blocks {
                if block["type"] == "tool_result" { events.push(ShellEvent::new("tool-result", json!({"id":block["tool_use_id"],"content":block["content"],"error":block["is_error"]}))); }
            } }
        }
        "control_request" if value["request"]["subtype"] == "can_use_tool" => events.push(ShellEvent::new("permission", json!({"requestId":value["request_id"],"toolId":value["request"]["tool_use_id"],"name":value["request"]["tool_name"],"input":value["request"]["input"],"suggestions":value["request"]["permission_suggestions"]}))),
        "control_response" => events.push(ShellEvent::new("control", value["response"].clone())),
        "result" => events.push(ShellEvent::new("complete", json!({"text":value["result"],"error":value["is_error"],"errors":value["errors"],"sessionId":value["session_id"]}))),
        "system" if value["subtype"] == "init" => events.push(ShellEvent::new("init", json!({"sessionId":value["session_id"],"model":value["model"],"commands":value["slash_commands"],"permissionMode":value["permissionMode"]}))),
        "system" if value["subtype"] == "error" => events.push(ShellEvent::new("error", json!({"text":value["message"]}))),
        _ => {}
    }
    events
}

/// Native app-server tools use the same identity-preserving shell cards.
pub fn normalize_codex(value: &Value) -> Vec<ShellEvent> {
    let p = &value["params"];
    let method = value["method"].as_str().unwrap_or("");
    let item = &p["item"];
    let id = &item["id"];
    match method {
        "item/started" => {
            let (name, input) = match item["type"].as_str().unwrap_or("") {
                "commandExecution" => {
                    ("Bash", json!({"command":item["command"],"cwd":item["cwd"]}))
                }
                "fileChange" => (
                    "Edit",
                    json!({"file_path":item["changes"][0]["path"],"content":item["changes"].as_array().map(|changes|changes.iter().filter_map(|change|change["diff"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()}),
                ),
                "webSearch" => ("WebSearch", json!({"query":item["query"]})),
                "mcpToolCall" => (
                    "MCP",
                    json!({"server":item["server"],"tool":item["tool"],"arguments":item["arguments"]}),
                ),
                _ => return vec![],
            };
            vec![ShellEvent::new(
                "tool",
                json!({"id":id,"name":name,"input":input}),
            )]
        }
        "item/completed" if item["type"] != "agentMessage" => vec![ShellEvent::new(
            "tool-result",
            json!({"id":id,"content":item.get("aggregatedOutput").or_else(||item.get("result")).unwrap_or(item),"error":item["status"]=="failed"}),
        )],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permissions_keep_the_request_and_tool_identity() {
        let events = normalize(
            &json!({"type":"control_request","request_id":"permission-1","request":{"subtype":"can_use_tool","tool_use_id":"tool-1","tool_name":"Write","input":{"file_path":"file.txt"}}}),
        );
        assert_eq!(events[0].kind, "permission");
        assert_eq!(events[0].data["requestId"], "permission-1");
        assert_eq!(events[0].data["toolId"], "tool-1");
    }
    #[test]
    fn golden_host_protocol_normalizes_questions_and_plan_tools() {
        let wire = include_str!("../../scripts/fixtures/agent-shell/host.jsonl");
        let events: Vec<_> = wire
            .lines()
            .flat_map(|line| normalize(&serde_json::from_str::<Value>(line).unwrap()))
            .collect();
        assert!(events
            .iter()
            .any(|event| event.kind == "permission" && event.data["name"] == "AskUserQuestion"));
        assert!(events
            .iter()
            .any(|event| event.kind == "tool" && event.data["name"] == "ExitPlanMode"));
        assert!(events.iter().any(|event| event.kind == "complete"));
    }
}
