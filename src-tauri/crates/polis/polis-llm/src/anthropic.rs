// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Anthropic Messages API backend (feature `anthropic`): one `POST
//! /v1/messages` per turn, no tools, no streaming — a memory pass reads one
//! reply. Stateless: `AgentRequest::resume` is ignored and `session_id` is
//! always `None`.
//!
//! Defaults follow the current API: `claude-opus-5` (thinking is on by
//! default there — the `thinking` parameter is omitted), `max_tokens`
//! 16,000 for a non-streaming call, and server-side refusal fallbacks opted
//! in (`fallbacks: "default"` under its beta header) so a policy decline is
//! re-run on a fallback model inside the same call; `fallbacks = false`
//! turns that off. A final `stop_reason: "refusal"` is a turn error carrying
//! the `stop_details` explanation.

use serde_json::{json, Value};

use crate::{finish, Agent, AgentError, AgentReply, AgentRequest, Usage};

pub const DEFAULT_MODEL: &str = "claude-opus-5";
pub const DEFAULT_MAX_TOKENS: u32 = 16_000;
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2023-06-01";
/// The beta that enables `fallbacks: "default"`.
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

pub struct AnthropicApi {
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
    pub base_url: String,
    pub system: Option<String>,
    pub fallbacks: bool,
    http: reqwest::Client,
}

impl AnthropicApi {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            model: DEFAULT_MODEL.to_string(),
            max_tokens: DEFAULT_MAX_TOKENS,
            base_url: DEFAULT_BASE_URL.to_string(),
            system: None,
            fallbacks: true,
            http: reqwest::Client::new(),
        }
    }

    /// From `ANTHROPIC_API_KEY`; `None` when it is unset — the "no model" state.
    pub fn from_env() -> Option<Self> {
        let key = std::env::var("ANTHROPIC_API_KEY").ok()?;
        let key = key.trim();
        if key.is_empty() {
            return None;
        }
        Some(Self::new(key))
    }

    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    pub fn system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    /// The request body — pure, so the wire shape is testable.
    pub fn body(&self, prompt: &str) -> Value {
        let mut body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": [{ "role": "user", "content": prompt }],
        });
        if let Some(system) = &self.system {
            body["system"] = json!(system);
        }
        if self.fallbacks {
            body["fallbacks"] = json!("default");
        }
        body
    }

    /// Text and usage off a Messages API response. A `refusal` stop is an
    /// error; every other stop reason yields the concatenated text blocks.
    pub fn parse_response(v: &Value) -> Result<(String, Usage), String> {
        let u = v.get("usage").cloned().unwrap_or(Value::Null);
        let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        let usage = Usage {
            model: v.get("model").and_then(Value::as_str).map(str::to_string),
            input_tokens: g("input_tokens"),
            output_tokens: g("output_tokens"),
            cache_read_tokens: g("cache_read_input_tokens"),
            cache_creation_tokens: g("cache_creation_input_tokens"),
        };
        if v.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
            let why = v
                .pointer("/stop_details/explanation")
                .and_then(Value::as_str)
                .unwrap_or("the request was declined");
            return Err(format!("refusal: {why}"));
        }
        if let Some(err) = v.get("error") {
            let msg = err.get("message").and_then(Value::as_str).unwrap_or("api error");
            return Err(msg.to_string());
        }
        let text: String = v
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        Ok((text, usage))
    }
}

#[async_trait::async_trait]
impl Agent for AnthropicApi {
    fn name(&self) -> &'static str {
        "anthropic"
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentReply, AgentError> {
        let mut call = self
            .http
            .post(format!("{}/v1/messages", self.base_url.trim_end_matches('/')))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json");
        if self.fallbacks {
            call = call.header("anthropic-beta", FALLBACK_BETA);
        }
        let resp = call
            .json(&self.body(&req.prompt))
            .send()
            .await
            .map_err(|e| AgentError::transport(format!("anthropic request failed: {e}")))?;
        let status = resp.status();
        let v: Value = resp
            .json()
            .await
            .map_err(|e| AgentError::transport(format!("anthropic response was not JSON: {e}")))?;
        if !status.is_success() {
            let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("api error");
            return Err(AgentError::turn(format!("anthropic {status}: {msg}"), Usage::default(), None));
        }
        match Self::parse_response(&v) {
            Ok((text, usage)) => Ok(finish(text, None, usage, &req)),
            Err(msg) => {
                let (_, usage) = Self::parse_response(&json!({ "usage": v.get("usage"), "content": [] }))
                    .unwrap_or_default();
                Err(AgentError::turn(msg, usage, None))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_carries_the_current_defaults() {
        let a = AnthropicApi::new("k").system("be brief");
        let b = a.body("hello");
        assert_eq!(b["model"], DEFAULT_MODEL);
        assert_eq!(b["max_tokens"], DEFAULT_MAX_TOKENS);
        assert_eq!(b["messages"][0]["content"], "hello");
        assert_eq!(b["system"], "be brief");
        assert_eq!(b["fallbacks"], "default");
        assert!(b.get("thinking").is_none(), "thinking is on by default on this model — never sent explicitly");
        let mut off = AnthropicApi::new("k");
        off.fallbacks = false;
        assert!(off.body("x").get("fallbacks").is_none());
    }

    #[test]
    fn parses_text_usage_and_refusals() {
        let ok: Value = serde_json::json!({
            "model": "claude-opus-5", "stop_reason": "end_turn",
            "content": [{"type":"thinking","thinking":""},{"type":"text","text":"a"},{"type":"text","text":"b"}],
            "usage": {"input_tokens": 3, "output_tokens": 2, "cache_read_input_tokens": 1, "cache_creation_input_tokens": 0}
        });
        let (text, usage) = AnthropicApi::parse_response(&ok).unwrap();
        assert_eq!(text, "ab");
        assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens), (3, 2, 1));
        assert_eq!(usage.model.as_deref(), Some("claude-opus-5"));

        let refused: Value = serde_json::json!({
            "stop_reason": "refusal", "stop_details": {"type":"refusal","category":"cyber","explanation":"nope"},
            "content": [], "usage": {"input_tokens": 3}
        });
        assert_eq!(AnthropicApi::parse_response(&refused).unwrap_err(), "refusal: nope");
    }

    #[test]
    fn from_env_is_none_without_a_key() {
        std::env::remove_var("ANTHROPIC_API_KEY");
        assert!(AnthropicApi::from_env().is_none());
    }
}
