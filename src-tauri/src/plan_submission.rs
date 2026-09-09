// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The provider-neutral boundary of the held plan protocol.
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct PlanSubmission {
    pub backend: &'static str,
    pub conversation_id: String,
    pub generation_id: String,
    pub cwd: String,
    pub model: Option<String>,
    pub plan: String,
}

impl PlanSubmission {
    pub fn into_payload(self) -> Value {
        json!({"session_id":self.conversation_id,"tool_use_id":self.generation_id,
            "cwd":self.cwd,"model":self.model,"redline_provider":self.backend,
            "tool_input":{"plan":self.plan}})
    }
}

pub enum ReviewDecision {
    Approve,
    Continue(String),
}
impl ReviewDecision {
    pub fn encode(self, backend: &str) -> Value {
        match (backend, self) {
            ("cursor", Self::Continue(reason)) => json!({"followup_message":reason}),
            ("antigravity", Self::Continue(reason)) => {
                json!({"decision":"continue","reason":reason})
            }
            ("antigravity", Self::Approve) => json!({"decision":"allow"}),
            (_, Self::Continue(reason)) => json!({"decision":"block","reason":reason}),
            (_, Self::Approve) => json!({}),
        }
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

/// One entire envelope, never a code example, partial response, or quoted mention.
pub fn envelope(text: &str) -> Option<String> {
    const OPEN: &str = "<proposed_plan>";
    const CLOSE: &str = "</proposed_plan>";
    if text.len() > 2 * 1024 * 1024
        || text.matches(OPEN).count() != 1
        || text.matches(CLOSE).count() != 1
    {
        return None;
    }
    let body = text.trim().strip_prefix(OPEN)?.strip_suffix(CLOSE)?.trim();
    (!body.is_empty()).then(|| body.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_envelopes() {
        assert_eq!(
            envelope(" <proposed_plan>\n# Plan\n</proposed_plan> ").as_deref(),
            Some("# Plan")
        );
        for input in [
            "ordinary",
            "<proposed_plan>missing",
            "<proposed_plan> </proposed_plan>",
            "Example `<proposed_plan>x</proposed_plan>`",
            "</proposed_plan><proposed_plan>x</proposed_plan>",
            "<proposed_plan>x</proposed_plan><proposed_plan>y</proposed_plan>",
        ] {
            assert!(envelope(input).is_none(), "{input}");
        }
    }
    #[test]
    fn decisions_preserve_inline_feedback() {
        for backend in ["cursor", "antigravity", "codex"] {
            let response =
                ReviewDecision::Continue("questions\nfull feedback".into()).encode(backend);
            let key = if backend == "cursor" {
                "followup_message"
            } else {
                "reason"
            };
            assert_eq!(response[key], "questions\nfull feedback");
            assert!(ReviewDecision::Approve.encode(backend).get(key).is_none());
        }
    }
}
