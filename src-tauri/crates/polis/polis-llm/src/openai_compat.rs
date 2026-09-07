// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! An OpenAI-compatible chat-completions backend (feature `openai-compat`):
//! Ollama, LM Studio, vLLM, OpenRouter and the like — anything that serves
//! `POST {base}/chat/completions`. One request per turn, no tools, no
//! streaming, stateless (`resume` ignored). A key is optional: a local server
//! usually has none.

use serde_json::{json, Value};

use crate::{finish, Agent, AgentError, AgentReply, AgentRequest, Usage};

pub struct OpenAiCompat {
    /// e.g. `http://127.0.0.1:11434/v1` (Ollama), `http://localhost:1234/v1`
    /// (LM Studio), `https://openrouter.ai/api/v1`.
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub max_tokens: u32,
    pub system: Option<String>,
    http: reqwest::Client,
}

impl OpenAiCompat {
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: None,
            model: model.into(),
            max_tokens: 16_000,
            system: None,
            http: reqwest::Client::new(),
        }
    }

    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    pub fn system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    pub fn body(&self, prompt: &str) -> Value {
        let mut messages = Vec::new();
        if let Some(system) = &self.system {
            messages.push(json!({ "role": "system", "content": system }));
        }
        messages.push(json!({ "role": "user", "content": prompt }));
        json!({ "model": self.model, "max_tokens": self.max_tokens, "messages": messages })
    }

    pub fn parse_response(v: &Value) -> Result<(String, Usage), String> {
        if let Some(err) = v.get("error") {
            let msg = err.get("message").and_then(Value::as_str).unwrap_or("api error");
            return Err(msg.to_string());
        }
        let u = v.get("usage").cloned().unwrap_or(Value::Null);
        let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        let usage = Usage {
            model: v.get("model").and_then(Value::as_str).map(str::to_string),
            input_tokens: g("prompt_tokens"),
            output_tokens: g("completion_tokens"),
            cache_read_tokens: u
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            cache_creation_tokens: 0,
        };
        let text = v
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Ok((text, usage))
    }
}

#[async_trait::async_trait]
impl Agent for OpenAiCompat {
    fn name(&self) -> &'static str {
        "openai-compat"
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentReply, AgentError> {
        let mut call = self
            .http
            .post(format!("{}/chat/completions", self.base_url.trim_end_matches('/')))
            .header("content-type", "application/json");
        if let Some(key) = &self.api_key {
            call = call.bearer_auth(key);
        }
        let resp = call
            .json(&self.body(&req.prompt))
            .send()
            .await
            .map_err(|e| AgentError::transport(format!("chat-completions request failed: {e}")))?;
        let status = resp.status();
        let v: Value = resp
            .json()
            .await
            .map_err(|e| AgentError::transport(format!("chat-completions response was not JSON: {e}")))?;
        if !status.is_success() {
            let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("api error");
            return Err(AgentError::turn(format!("{status}: {msg}"), Usage::default(), None));
        }
        match Self::parse_response(&v) {
            Ok((text, usage)) => Ok(finish(text, None, usage, &req)),
            Err(msg) => Err(AgentError::turn(msg, Usage::default(), None)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_and_response_follow_the_chat_completions_shape() {
        let c = OpenAiCompat::new("http://127.0.0.1:11434/v1", "llama3").system("s");
        let b = c.body("hi");
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["content"], "hi");
        let v: Value = serde_json::json!({
            "model": "llama3",
            "choices": [{"message": {"role": "assistant", "content": "yo"}}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 2}}
        });
        let (text, usage) = OpenAiCompat::parse_response(&v).unwrap();
        assert_eq!(text, "yo");
        assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens), (4, 1, 2));
    }
}
