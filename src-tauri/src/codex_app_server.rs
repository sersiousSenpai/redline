// SPDX-License-Identifier: Apache-2.0
//! Minimal typed client for Codex's JSONL app-server protocol.
//!
//! This one-shot path is intentionally the first adapter: it gives tool-less
//! seats a real Codex execution path while the same wire primitives can be
//! promoted into a long-lived manager for conversational seats.

use std::path::Path;
use std::process::Stdio;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

pub fn resolve_codex_bin() -> String {
    let candidates = [
        std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/bin/codex")),
        Some("/opt/homebrew/bin/codex".into()),
        Some("/usr/local/bin/codex".into()),
    ];
    candidates.into_iter().flatten().find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "codex".to_string())
}

pub fn codex_available() -> bool {
    let bin = resolve_codex_bin();
    Path::new(&bin).is_file()
        || std::process::Command::new(&bin)
            .arg("--version")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .status().is_ok_and(|status| status.success())
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

pub async fn run_one_shot(cwd: &Path, prompt: &str, model: Option<&str>) -> Result<String, String> {
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
    loop {
        let line = lines.next_line().await.map_err(|e| e.to_string())?.ok_or("codex app-server exited before turn completion")?;
        let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        if method.contains("agentMessage") && method.ends_with("delta") {
            if let Some(delta) = agent_text(&value) { text.push_str(delta); }
        } else if method == "item/completed" && text.is_empty() {
            if let Some(final_text) = agent_text(&value) { text.push_str(final_text); }
        } else if method == "turn/completed" {
            break;
        } else if value.get("id").is_some() && value.get("method").is_some() {
            // A tool-less, read-only turn should never request approval. Deny
            // defensively so an unexpected server request cannot hang Redline.
            let id = value["id"].clone();
            send(&mut stdin, json!({"jsonrpc":"2.0","id":id,"result":{"decision":"decline"}})).await?;
        }
    }
    let _ = child.kill().await;
    if text.trim().is_empty() { Err("codex ended without producing a response".into()) } else { Ok(text) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_rpc_responses_and_agent_text() {
        assert_eq!(response_result(&json!({"id":2,"result":{"ok":true}}), 2).unwrap().unwrap()["ok"], true);
        assert_eq!(agent_text(&json!({"params":{"delta":"hello"}})), Some("hello"));
    }
}
