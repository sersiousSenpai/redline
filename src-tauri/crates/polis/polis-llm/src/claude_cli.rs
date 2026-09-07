// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Claude Code CLI backend: `claude -p <prompt> --output-format
//! stream-json …`, one line at a time.
//!
//! [`StreamLine`] / [`classify_line`] are the stream-json line classifier
//! every Redline surface reads with — lifted verbatim in Session A4 of the
//! Polis extraction (see `docs/protocol-verification.md` there for the
//! captured shapes). [`ClaudeCli`] is the standalone backend built on them.

use serde_json::Value;
use tokio::process::Command;

use crate::{finish, process, Agent, AgentError, AgentReply, AgentRequest, Usage};

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
                // The subtype fallback is a MACHINE KEY, not a message. When
                // `result` is empty (the overload/capacity case) this yields
                // the bare `error_during_execution`, and `is_transient` below
                // matches on that literal substring — as does
                // `seat::is_resume_failure`. Do NOT humanise it here: friendly
                // text at the source silently breaks the classification for
                // every surface. `StreamLine::Failed` stays raw; humanising
                // happens at the persist/display boundary, in
                // `describe_turn_error`. Guarded by `classify_result_error`.
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

/// Usage off the CLI's terminal `result` line — the standalone accounting:
/// adopt what the CLI totalled, and the model the first `assistant` line
/// named (`fold_model`). A host with its own accounting rule (Redline's
/// `TurnMeter`) folds every line itself and never calls this.
pub fn usage_from_result(v: &Value, model: Option<String>) -> Usage {
    let u = v.get("usage").cloned().unwrap_or(Value::Null);
    let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    let model = model.or_else(|| {
        v.get("modelUsage")
            .and_then(Value::as_object)
            .and_then(|m| m.keys().next().cloned())
    });
    Usage {
        model,
        input_tokens: g("input_tokens"),
        output_tokens: g("output_tokens"),
        cache_read_tokens: g("cache_read_input_tokens"),
        cache_creation_tokens: g("cache_creation_input_tokens"),
    }
}

/// The model an `assistant` line names, when it does.
pub fn fold_model(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    v.pointer("/message/model").and_then(Value::as_str).map(str::to_string)
}

/// The flag block a standalone memory pass runs with: stream-json (so the
/// session id and usage are observable), the read-only tool surface, MCP
/// stripped. A host with its own block (Redline's `bridge_args`) uses that.
pub const DEFAULT_ARGS: &[&str] = &[
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "default",
    "--tools",
    "Read,Grep,Glob",
    "--strict-mcp-config",
];

/// `claude -p <prompt> …` as an [`Agent`].
pub struct ClaudeCli {
    pub bin: String,
    /// The flags after `-p <prompt>`; `--resume <sid>` is appended per turn.
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl ClaudeCli {
    pub fn new(bin: impl Into<String>) -> Self {
        Self { bin: bin.into(), args: DEFAULT_ARGS.iter().map(|s| s.to_string()).collect(), env: Vec::new() }
    }

    pub fn argv(&self, req: &AgentRequest) -> Vec<String> {
        let mut argv = vec!["-p".to_string(), req.prompt.clone()];
        argv.extend(self.args.iter().cloned());
        if let Some(sid) = &req.resume {
            argv.push("--resume".to_string());
            argv.push(sid.clone());
        }
        argv
    }
}

#[async_trait::async_trait]
impl Agent for ClaudeCli {
    fn name(&self) -> &'static str {
        "claude-cli"
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentReply, AgentError> {
        let mut cmd = Command::new(&self.bin);
        cmd.args(self.argv(&req));
        cmd.env("POLIS_AGENT_SEAT", &req.seat);
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &req.cwd {
            cmd.current_dir(cwd);
        }
        let child = process::spawn(&mut cmd).map_err(|(not_found, e)| {
            if not_found {
                AgentError::unavailable(format!("could not find the `claude` CLI (looked for `{}`)", self.bin))
            } else {
                AgentError::spawn(format!("failed to spawn claude: {e}"))
            }
        })?;
        let mut session: Option<String> = None;
        let mut final_text: Option<String> = None;
        let mut errored: Option<String> = None;
        let mut model: Option<String> = None;
        let mut usage = Usage::default();
        let drained = process::drive(child, |v| {
            if model.is_none() {
                model = fold_model(v);
            }
            if v.get("type").and_then(Value::as_str) == Some("result") {
                usage = usage_from_result(v, model.clone());
            }
            match classify_line(v) {
                StreamLine::Init(sid) => session = Some(sid),
                StreamLine::Final { text, session_id } => {
                    if session_id.is_some() {
                        session = session_id;
                    }
                    final_text = Some(text);
                }
                StreamLine::Failed(msg) => errored = Some(msg),
                StreamLine::Delta(_) | StreamLine::Ignore => {}
            }
        })
        .await;
        if let Some(msg) = errored {
            return Err(AgentError::turn(msg, usage, session));
        }
        match final_text {
            Some(text) => Ok(finish(text, session, usage, &req)),
            None => Err(AgentError::turn(
                if drained.stderr.trim().is_empty() {
                    format!("{} produced no output", req.seat)
                } else {
                    format!("{} failed: {}", req.seat, drained.stderr.trim())
                },
                usage,
                session,
            )),
        }
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

    #[test]
    fn usage_adopts_the_result_line_and_names_the_model() {
        let assistant: Value = serde_json::from_str(r#"{"type":"assistant","message":{"model":"claude-sonnet-5","content":[]}}"#).unwrap();
        let model = fold_model(&assistant);
        assert_eq!(model.as_deref(), Some("claude-sonnet-5"));
        let result: Value = serde_json::from_str(r#"{"type":"result","subtype":"success","is_error":false,"result":"x","usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":100,"cache_creation_input_tokens":7},"modelUsage":{"claude-sonnet-5":{"contextWindow":200000}}}"#).unwrap();
        let u = usage_from_result(&result, model);
        assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens), (10, 4, 100, 7));
        assert_eq!(u.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(usage_from_result(&result, None).model.as_deref(), Some("claude-sonnet-5"), "modelUsage is the fallback");
    }

    #[test]
    fn argv_puts_the_prompt_first_and_resume_last() {
        let c = ClaudeCli::new("claude");
        let a = c.argv(&AgentRequest::new("keeper", "hello").resume("s-1"));
        assert_eq!(&a[..2], ["-p", "hello"]);
        assert_eq!(&a[a.len() - 2..], ["--resume", "s-1"]);
        assert!(a.contains(&"--strict-mcp-config".to_string()));
    }

    #[tokio::test]
    async fn a_missing_claude_is_unavailable_not_failed() {
        let c = ClaudeCli::new("/nonexistent/claude");
        let e = c.run(AgentRequest::new("keeper", "p")).await.err().unwrap();
        assert_eq!(e.kind, crate::AgentErrorKind::Unavailable);
    }
}
