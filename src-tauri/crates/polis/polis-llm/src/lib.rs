// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `polis-llm` — the model behind the gardener, as a trait.
//!
//! The memory passes (classify, verify a supersession, summarize a cold
//! body, observe patterns, caption a page) each send ONE prompt and read ONE
//! reply. That is the whole contract, and [`Agent`] is exactly that: a seat
//! name, a prompt, an optional cwd and session to resume, a reply with its
//! text, its session id and what it cost. Nothing about tools, streaming to a
//! pane, or a conversation — those are a host's discussion surfaces, not
//! memory's.
//!
//! Backends: [`claude_cli::ClaudeCli`] (`claude -p … --output-format
//! stream-json`) and [`codex_cli::CodexCli`] (`codex exec --json`) need no
//! key and no network client; `anthropic` and `openai_compat` (features) call
//! the APIs directly. A host may implement [`Agent`] over its own spawn
//! plumbing — Redline does, so its seat overrides, its capture-hook guard and
//! its accounting rule stay exactly as they were.
//!
//! What a turn costs comes back as [`Usage`] on both the success and the
//! error path (a failed turn spent its input tokens), and the caller books it
//! through a [`UsageSink`]. "Every exit books" is the caller's one obligation.
//!
//! No model configured is a real state, not an error: the gardener runs its
//! deterministic tiers with `agent = None` (R12). This crate only ever holds
//! the `Some`.

pub mod claude_cli;
pub mod codex_cli;
pub mod process;

#[cfg(feature = "anthropic")]
pub mod anthropic;
#[cfg(feature = "openai-compat")]
pub mod openai_compat;

use std::path::PathBuf;

pub use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What one turn spent. The four counters are the ones every backend can
/// report and every host books; `model` is what actually answered when the
/// backend can tell.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

impl Usage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_creation_tokens)
    }

    /// Nothing was spent and nothing was observed — not worth a booking.
    pub fn is_empty(&self) -> bool {
        self.total_tokens() == 0 && self.model.is_none()
    }
}

/// One prompt to one seat.
#[derive(Debug, Clone)]
pub struct AgentRequest {
    /// The Agent Seat this turn runs as (`classifier`, `keeper`, …). A host
    /// maps it to a model/effort/binary; the CLI backends put it in the
    /// environment so a capture hook can recognise machine text.
    pub seat: String,
    pub prompt: String,
    pub cwd: Option<PathBuf>,
    /// A prior session to continue, in the backend's own id-space (a claude
    /// session id, a codex thread id). The HTTP backends are stateless and
    /// ignore it.
    pub resume: Option<String>,
    /// When the reply is expected to carry a JSON object with this key, the
    /// reply's `json` is that object, extracted tolerantly (prose and fences
    /// around it are fine). The text is returned regardless.
    pub response_key: Option<&'static str>,
    /// Clip the reply text to this many bytes (on a char boundary); 0 = no
    /// clip. The clip is reported, never silent: `AgentReply::clipped`.
    pub max_output_bytes: usize,
}

impl AgentRequest {
    pub fn new(seat: impl Into<String>, prompt: impl Into<String>) -> Self {
        Self {
            seat: seat.into(),
            prompt: prompt.into(),
            cwd: None,
            resume: None,
            response_key: None,
            max_output_bytes: 0,
        }
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn resume(mut self, session: impl Into<String>) -> Self {
        self.resume = Some(session.into());
        self
    }

    pub fn response_key(mut self, key: &'static str) -> Self {
        self.response_key = Some(key);
        self
    }

    pub fn max_output_bytes(mut self, n: usize) -> Self {
        self.max_output_bytes = n;
        self
    }
}

/// What came back.
#[derive(Debug, Clone)]
pub struct AgentReply {
    pub text: String,
    /// The object under `AgentRequest::response_key`, when asked for and
    /// present.
    pub json: Option<Value>,
    /// The backend's session/thread id, when it has one — what a later
    /// `resume` names.
    pub session_id: Option<String>,
    pub usage: Usage,
    /// The text was clipped to `max_output_bytes`.
    pub clipped: bool,
}

/// Why a turn produced no reply. `usage` is carried on the error too: a
/// failed turn spent its input tokens, and the caller books it either way.
#[derive(Debug, Clone)]
pub struct AgentError {
    pub kind: AgentErrorKind,
    /// The backend's own words, kept RAW (a host humanises at its display
    /// boundary and may classify on the machine string).
    pub message: String,
    pub usage: Usage,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentErrorKind {
    /// The binary is not installed / the key is not set — the "no model"
    /// state, which the gardener treats as a capability, not a failure.
    Unavailable,
    /// The process could not be started.
    Spawn,
    /// The model ran and reported an error (or nothing at all).
    Turn,
    /// The HTTP call failed.
    Transport,
}

impl AgentError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self { kind: AgentErrorKind::Unavailable, message: message.into(), usage: Usage::default(), session_id: None }
    }

    pub fn spawn(message: impl Into<String>) -> Self {
        Self { kind: AgentErrorKind::Spawn, message: message.into(), usage: Usage::default(), session_id: None }
    }

    pub fn turn(message: impl Into<String>, usage: Usage, session_id: Option<String>) -> Self {
        Self { kind: AgentErrorKind::Turn, message: message.into(), usage, session_id }
    }

    pub fn transport(message: impl Into<String>) -> Self {
        Self { kind: AgentErrorKind::Transport, message: message.into(), usage: Usage::default(), session_id: None }
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AgentError {}

/// One prompt in, one reply out. Object-safe: the gardener holds
/// `Option<Arc<dyn Agent>>`.
#[async_trait]
pub trait Agent: Send + Sync {
    /// A stable backend name for logs and `catalog_health` (`claude-cli`,
    /// `codex-cli`, `anthropic`, …).
    fn name(&self) -> &'static str;
    async fn run(&self, req: AgentRequest) -> Result<AgentReply, AgentError>;
}

/// Where a turn's cost goes. Redline books it onto the seat's daily burn row;
/// a standalone `polis` writes it to its run journal.
pub trait UsageSink: Send + Sync {
    fn book(&self, seat: &str, usage: &Usage);
}

/// Books nothing — for tests and for a host with no accounting.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopSink;

impl UsageSink for NoopSink {
    fn book(&self, _seat: &str, _usage: &Usage) {}
}

/// Build the reply from a backend's raw result: clip to the request's byte
/// cap (char-boundary safe, and reported) and extract the JSON the caller
/// asked for. Every backend finishes through here so the contract is one
/// implementation.
pub fn finish(text: String, session_id: Option<String>, usage: Usage, req: &AgentRequest) -> AgentReply {
    let json = req.response_key.and_then(|k| polis_core::json::extract_object_with_key(&text, k));
    let (text, clipped) = clip(text, req.max_output_bytes);
    AgentReply { text, json, session_id, usage, clipped }
}

fn clip(text: String, max: usize) -> (String, bool) {
    if max == 0 || text.len() <= max {
        return (text, false);
    }
    let mut cut = max;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    (text[..cut].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_totals_and_emptiness() {
        let u = Usage { input_tokens: 10, cache_read_tokens: 5, ..Default::default() };
        assert_eq!(u.total_tokens(), 15);
        assert!(!u.is_empty());
        assert!(Usage::default().is_empty());
        let observed_only = Usage { model: Some("m".into()), ..Default::default() };
        assert!(!observed_only.is_empty(), "a model was observed — worth a provenance row");
    }

    #[test]
    fn finish_extracts_the_keyed_object_and_clips_on_a_char_boundary() {
        let req = AgentRequest::new("classifier", "p").response_key("proposals").max_output_bytes(12);
        let text = "Sure — ```json\n{\"proposals\":[{\"op\":\"create\"}]}\n``` done".to_string();
        let r = finish(text, Some("s1".into()), Usage::default(), &req);
        assert_eq!(r.json.unwrap()["proposals"][0]["op"], "create", "extracted before the clip");
        assert!(r.clipped);
        assert!(r.text.len() <= 12);
        assert!(r.text.is_char_boundary(r.text.len()));
        assert_eq!(r.session_id.as_deref(), Some("s1"));

        let unclipped = finish("héllo".into(), None, Usage::default(), &AgentRequest::new("k", "p"));
        assert!(!unclipped.clipped);
        assert_eq!(unclipped.text, "héllo");
    }

    #[test]
    fn errors_carry_usage_so_every_exit_can_book() {
        let e = AgentError::turn("error_during_execution", Usage { input_tokens: 9, ..Default::default() }, None);
        assert_eq!(e.kind, AgentErrorKind::Turn);
        assert_eq!(e.usage.input_tokens, 9);
        assert_eq!(e.to_string(), "error_during_execution", "the machine string stays raw");
    }

    #[test]
    fn agent_is_object_safe() {
        fn takes(_: &dyn Agent) {}
        let _: fn(&dyn Agent) = takes;
    }
}
