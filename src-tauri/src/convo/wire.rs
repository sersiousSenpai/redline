// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The conversation mirror's wire types, serialized to exactly the shapes in
//! `src/lib/convo/types.ts` (camelCase fields, a snake_case `kind` tag). The
//! golden fixtures under `tests/fixtures/convo/` pin them from both sides.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One mirrored event. `id` is stable across re-reads of the same bytes;
/// `(epoch, offset)` orders; `ts` is epoch ms.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvoEvent {
    pub id: String,
    pub epoch: u32,
    pub offset: u64,
    pub ts: i64,
    #[serde(flatten)]
    pub body: Body,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Body {
    Bound {
        harness: String,
        session_id: String,
        transcript_path: Option<String>,
        source: String,
        /// `false`: a Codex session no second client can read (one Redline's
        /// launcher didn't start), shown in its terminal only. Absent
        /// otherwise.
        #[serde(skip_serializing_if = "Option::is_none")]
        mirrored: Option<bool>,
    },
    Epoch { reason: String },
    UserText { text: String, prompt_id: Option<String> },
    AssistantText { text: String, model: Option<String> },
    Thinking,
    ToolUse { tool_use_id: String, name: String, summary: String },
    ToolResult { tool_use_id: String, is_error: bool, preview: String },
    Interrupted,
    ModeChange { mode: String },
    ModelSeen { model: String, effort: Option<String> },
    Compact { trigger: Option<String> },
    TurnEnd { duration_ms: Option<u64> },
    Queued { op: String, text: Option<String>, reason: Option<String> },
    PlanProposed { tool_use_id: String, session_id: String, title: Option<String> },
    PlanOutcome { tool_use_id: String, outcome: String, feedback: Option<String> },
    AskOpened { ask: ConvoAsk },
    AskClosed { ask_id: String, outcome: String },
    Delivered { nonce: String, prompt_id: Option<String> },
    Undelivered { nonce: String },
    Readiness { ready: bool, blocker: Option<Blocker> },
}

impl Body {
    /// A rough byte cost for the ring's budget: the strings it holds plus a
    /// fixed overhead. Exactness doesn't matter; a bound does.
    pub fn weight(&self) -> usize {
        64 + match self {
            Body::UserText { text, .. } | Body::AssistantText { text, .. } => text.len(),
            Body::ToolUse { summary, .. } => summary.len(),
            Body::ToolResult { preview, .. } => preview.len(),
            Body::Queued { text, .. } => text.as_ref().map_or(0, String::len),
            Body::PlanOutcome { feedback, .. } => feedback.as_ref().map_or(0, String::len),
            Body::AskOpened { ask } => ask.summary.len() + ask.input.as_ref().map_or(0, |v| v.to_string().len()),
            _ => 0,
        }
    }
}

/// Why the composer can't type into the PTY right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocker {
    Unbound,
    NoPasteMode,
    NativeDialog,
    DirtyInput,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestion {
    pub question: String,
    pub header: Option<String>,
    pub multi_select: bool,
    pub options: Vec<AskOption>,
}

/// One open ask, held by a hook until the stage (or the terminal) answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvoAsk {
    pub ask_id: String,
    /// `permission` or `question`.
    pub kind: String,
    pub tool_name: String,
    pub summary: String,
    pub input: Option<Value>,
    pub suggestions: Option<Vec<Value>>,
    pub rule: Option<String>,
    pub questions: Option<Vec<AskQuestion>>,
    pub opened_at: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AskAnswer {
    Allow,
    Always,
    Deny {
        #[serde(default)]
        message: Option<String>,
    },
    Answers { answers: HashMap<String, String> },
    Terminal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvoSnapshot {
    pub subscription_id: String,
    pub events: Vec<ConvoEvent>,
    pub has_older: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvoBatch {
    pub events: Vec<ConvoEvent>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub reset: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvoPage {
    pub events: Vec<ConvoEvent>,
    pub has_older: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SubmitResult {
    Sent,
    Blocked { blocker: Blocker },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SwitchResult {
    Sent,
    Terminal { reason: String },
}

/// The app-wide `convo-bound` payload: the stage keeps a sessionId →
/// terminalId map from it (and from the attention entries).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundNotice {
    pub terminal_id: String,
    pub session_id: String,
    pub harness: String,
    pub transcript_path: Option<String>,
}

/// The app-wide `convo-title` payload: the CLI's own short title for the
/// session (its transcript's `ai-title` line, the same text its window title
/// carries after the status glyph).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleNotice {
    pub terminal_id: String,
    pub session_id: String,
    pub title: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(body: Body) -> Value {
        serde_json::to_value(ConvoEvent { id: "u".into(), epoch: 1, offset: 9, ts: 5, body }).unwrap()
    }

    /// The shapes `types.ts` declares, field for field.
    #[test]
    fn events_serialize_flat_camel_case_with_a_snake_case_kind() {
        assert_eq!(
            event(Body::ToolResult { tool_use_id: "t".into(), is_error: true, preview: "p".into() }),
            json!({"id": "u", "epoch": 1, "offset": 9, "ts": 5, "kind": "tool_result", "toolUseId": "t", "isError": true, "preview": "p"})
        );
        assert_eq!(event(Body::Thinking), json!({"id": "u", "epoch": 1, "offset": 9, "ts": 5, "kind": "thinking"}));
        assert_eq!(event(Body::TurnEnd { duration_ms: Some(3) })["durationMs"], 3);
        assert_eq!(
            event(Body::Readiness { ready: false, blocker: Some(Blocker::NoPasteMode) })["blocker"],
            "no_paste_mode"
        );
        assert_eq!(event(Body::Readiness { ready: true, blocker: None })["blocker"], Value::Null);
        let bound = event(Body::Bound { harness: "claude".into(), session_id: "s".into(), transcript_path: None, source: "startup".into(), mirrored: None });
        assert_eq!(bound["kind"], "bound");
        assert_eq!(bound["sessionId"], "s");
        assert_eq!(bound["transcriptPath"], Value::Null);
        assert!(bound.get("mirrored").is_none(), "absent unless a Codex session can't be read");
        let terminal_only = event(Body::Bound { harness: "codex".into(), session_id: "t".into(), transcript_path: None, source: "prompt".into(), mirrored: Some(false) });
        assert_eq!(terminal_only["mirrored"], false);
        let ask = ConvoAsk {
            ask_id: "a".into(), kind: "question".into(), tool_name: "AskUserQuestion".into(), summary: "s".into(),
            input: None, suggestions: None, rule: None, opened_at: 1,
            questions: Some(vec![AskQuestion { question: "q".into(), header: None, multi_select: false, options: vec![AskOption { label: "Red".into(), description: None }] }]),
        };
        let opened = event(Body::AskOpened { ask });
        assert_eq!(opened["ask"]["askId"], "a");
        assert_eq!(opened["ask"]["questions"][0]["multiSelect"], false);
        assert_eq!(opened["ask"]["openedAt"], 1);
    }

    #[test]
    fn results_and_answers_match_the_contract() {
        assert_eq!(serde_json::to_value(SubmitResult::Sent).unwrap(), json!({"status": "sent"}));
        assert_eq!(
            serde_json::to_value(SubmitResult::Blocked { blocker: Blocker::DirtyInput }).unwrap(),
            json!({"status": "blocked", "blocker": "dirty_input"})
        );
        assert_eq!(
            serde_json::to_value(SwitchResult::Terminal { reason: "busy".into() }).unwrap(),
            json!({"status": "terminal", "reason": "busy"})
        );
        assert_eq!(serde_json::to_value(ConvoBatch { events: vec![], reset: false }).unwrap(), json!({"events": []}));
        assert_eq!(serde_json::to_value(ConvoBatch { events: vec![], reset: true }).unwrap(), json!({"events": [], "reset": true}));
        let parse = |v: Value| serde_json::from_value::<AskAnswer>(v).unwrap();
        assert_eq!(parse(json!({"kind": "allow"})), AskAnswer::Allow);
        assert_eq!(parse(json!({"kind": "deny"})), AskAnswer::Deny { message: None });
        assert_eq!(parse(json!({"kind": "deny", "message": null})), AskAnswer::Deny { message: None });
        assert_eq!(
            parse(json!({"kind": "answers", "answers": {"Which?": "Blue"}})),
            AskAnswer::Answers { answers: HashMap::from([("Which?".to_string(), "Blue".to_string())]) }
        );
        assert_eq!(parse(json!({"kind": "terminal"})), AskAnswer::Terminal);
    }
}
