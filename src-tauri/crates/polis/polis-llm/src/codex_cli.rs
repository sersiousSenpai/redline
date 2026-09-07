// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Codex CLI backend: `codex exec --json <prompt>`, read-only, no
//! approvals, and the thread id kept so a later turn can `exec resume` it.
//!
//! The wire classifier mirrors Redline's `fork.rs` (the discussion surface
//! keeps its own copy — it renders deltas to a pane, which memory never
//! does): Codex emits each agent message as it completes and then a separate
//! `turn.completed` carrying only usage, so a reply is the messages joined,
//! never the last one alone.

use serde_json::Value;
use tokio::process::Command;

use crate::{finish, process, Agent, AgentError, AgentReply, AgentRequest, Usage};

/// One classified line of `codex exec --json` output.
#[derive(Debug, PartialEq, Eq)]
pub enum CodexLine {
    /// `thread.started` — the thread this turn runs in (the resume handle).
    Thread(String),
    /// A completed `agent_message` item — reply text.
    Message(String),
    /// `turn.completed` — the turn ended cleanly. Carries only usage.
    Completed,
    /// `turn.failed`, a top-level `error`, or a completed `error` item.
    Failed(String),
    /// Everything else: reasoning, command runs, file changes, tool calls —
    /// the agent's scratch work, never its answer.
    Ignore,
}

pub fn classify_codex_line(v: &Value) -> CodexLine {
    let text_at = |v: &Value, path: &str| {
        v.pointer(path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    match v.get("type").and_then(Value::as_str) {
        Some("thread.started") => match text_at(v, "/thread_id") {
            Some(id) => CodexLine::Thread(id),
            None => CodexLine::Ignore,
        },
        Some("item.completed") => match v.pointer("/item/type").and_then(Value::as_str) {
            Some("agent_message") => match text_at(v, "/item/text") {
                Some(text) => CodexLine::Message(text),
                None => CodexLine::Ignore,
            },
            Some("error") => CodexLine::Failed(
                text_at(v, "/item/message").unwrap_or_else(|| "codex reported an error".to_string()),
            ),
            _ => CodexLine::Ignore,
        },
        Some("turn.completed") => CodexLine::Completed,
        Some("turn.failed") | Some("error") => CodexLine::Failed(
            text_at(v, "/error/message")
                .or_else(|| text_at(v, "/message"))
                .unwrap_or_else(|| "codex reported an error".to_string()),
        ),
        _ => CodexLine::Ignore,
    }
}

/// Usage off a `turn.completed` line. Codex reports no model; the configured
/// one is carried so a badge can say what was asked for.
pub fn usage_from_turn(v: &Value, model: Option<&str>) -> Usage {
    let mut u = Usage { model: model.map(str::to_string), ..Default::default() };
    let usage = ["/params/usage", "/params/turn/usage", "/usage", "/turn/usage"]
        .iter()
        .find_map(|p| v.pointer(p))
        .filter(|u| u.is_object());
    let Some(obj) = usage else { return u };
    let g = |snake: &str, camel: &str| {
        obj.get(snake).or_else(|| obj.get(camel)).and_then(Value::as_u64).unwrap_or(0)
    };
    u.input_tokens = g("input_tokens", "inputTokens");
    u.output_tokens = g("output_tokens", "outputTokens");
    u.cache_read_tokens = g("cached_input_tokens", "cachedInputTokens");
    u
}

/// The flags that keep a memory pass read-only: sandbox `read-only`,
/// approvals `never`. Placed BEFORE `exec` — they are top-level options codex
/// rejects after the subcommand.
pub const DEFAULT_ARGS: &[&str] = &["-s", "read-only", "-a", "never"];

pub struct CodexCli {
    pub bin: String,
    /// Top-level options, before `exec`.
    pub args: Vec<String>,
    /// `-m <model>` when set.
    pub model: Option<String>,
    pub env: Vec<(String, String)>,
}

impl CodexCli {
    pub fn new(bin: impl Into<String>) -> Self {
        Self {
            bin: bin.into(),
            args: DEFAULT_ARGS.iter().map(|s| s.to_string()).collect(),
            model: None,
            env: Vec::new(),
        }
    }

    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// The argv after the binary, for a fresh or resumed turn.
    pub fn argv(&self, req: &AgentRequest) -> Vec<String> {
        let mut argv = self.args.clone();
        if let Some(m) = &self.model {
            argv.push("-m".to_string());
            argv.push(m.clone());
        }
        argv.push("exec".to_string());
        if let Some(sid) = &req.resume {
            argv.push("resume".to_string());
            argv.push("--json".to_string());
            argv.push("--skip-git-repo-check".to_string());
            argv.push(sid.clone());
        } else {
            argv.push("--json".to_string());
            argv.push("--skip-git-repo-check".to_string());
        }
        argv.push(req.prompt.clone());
        argv
    }
}

#[async_trait::async_trait]
impl Agent for CodexCli {
    fn name(&self) -> &'static str {
        "codex-cli"
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
                AgentError::unavailable(format!("could not find the `codex` CLI (looked for `{}`)", self.bin))
            } else {
                AgentError::spawn(format!("failed to spawn codex: {e}"))
            }
        })?;
        let mut thread: Option<String> = None;
        let mut text: Option<String> = None;
        let mut errored: Option<String> = None;
        let mut usage = Usage { model: self.model.clone(), ..Default::default() };
        let drained = process::drive(child, |v| match classify_codex_line(v) {
            CodexLine::Thread(id) => thread = Some(id),
            CodexLine::Message(m) => match &mut text {
                Some(prev) => {
                    prev.push_str("\n\n");
                    prev.push_str(&m);
                }
                None => text = Some(m),
            },
            CodexLine::Failed(msg) => errored = Some(msg),
            CodexLine::Completed => usage = usage_from_turn(v, self.model.as_deref()),
            CodexLine::Ignore => {}
        })
        .await;
        if let Some(msg) = errored {
            return Err(AgentError::turn(msg, usage, thread));
        }
        match text {
            Some(t) => Ok(finish(t, thread, usage, &req)),
            None => Err(AgentError::turn(
                if drained.stderr.trim().is_empty() {
                    format!("{} produced no output", req.seat)
                } else {
                    format!("{} failed: {}", req.seat, drained.stderr.trim())
                },
                usage,
                thread,
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> CodexLine {
        classify_codex_line(&serde_json::from_str::<Value>(line).unwrap())
    }

    #[test]
    fn classifies_the_exec_json_wire_contract() {
        assert_eq!(parse(r#"{"type":"thread.started","thread_id":"t-1"}"#), CodexLine::Thread("t-1".into()));
        assert_eq!(
            parse(r#"{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}"#),
            CodexLine::Message("hi".into())
        );
        assert_eq!(parse(r#"{"type":"item.completed","item":{"type":"reasoning","text":"…"}}"#), CodexLine::Ignore);
        assert_eq!(parse(r#"{"type":"turn.completed","usage":{"input_tokens":5}}"#), CodexLine::Completed);
        assert_eq!(parse(r#"{"type":"turn.failed","error":{"message":"boom"}}"#), CodexLine::Failed("boom".into()));
        assert_eq!(parse(r#"{"type":"error","message":"rate"}"#), CodexLine::Failed("rate".into()));
    }

    #[test]
    fn usage_reads_every_known_pointer_and_carries_the_configured_model() {
        let v: Value = serde_json::from_str(r#"{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3,"cached_input_tokens":2}}"#).unwrap();
        let u = usage_from_turn(&v, Some("gpt-5"));
        assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens), (7, 3, 2));
        assert_eq!(u.model.as_deref(), Some("gpt-5"));
        let nested: Value = serde_json::from_str(r#"{"params":{"turn":{"usage":{"inputTokens":1}}}}"#).unwrap();
        assert_eq!(usage_from_turn(&nested, None).input_tokens, 1);
    }

    #[test]
    fn argv_keeps_the_read_only_flags_before_exec_and_resumes_by_thread() {
        let c = CodexCli::new("codex").model("gpt-5");
        let fresh = c.argv(&AgentRequest::new("keeper", "p"));
        assert_eq!(fresh, ["-s", "read-only", "-a", "never", "-m", "gpt-5", "exec", "--json", "--skip-git-repo-check", "p"]);
        let resumed = c.argv(&AgentRequest::new("keeper", "p").resume("t-1"));
        assert_eq!(&resumed[6..], ["exec", "resume", "--json", "--skip-git-repo-check", "t-1", "p"]);
    }

    #[tokio::test]
    async fn a_missing_codex_is_unavailable_not_failed() {
        let c = CodexCli::new("/nonexistent/codex");
        let e = c.run(AgentRequest::new("keeper", "p")).await.err().unwrap();
        assert_eq!(e.kind, crate::AgentErrorKind::Unavailable);
    }
}
