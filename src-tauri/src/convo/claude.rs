// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Claude Code's transcript, one line at a time, as conversation events.
//!
//! The transcript (`~/.claude/projects/<slug>/<session>.jsonl`) is the CLI's
//! own record of the conversation, written as it happens: experiment (m)
//! measured a prompt line 130 ms after its UserPromptSubmit hook and a reply
//! line within a few hundred ms of the block finishing. Each assistant line
//! holds one content block, so prose lands per block, not per token, which is
//! the accepted trade-off.
//!
//! [`parse_line`] is a function of the line and its position alone. That is
//! what makes every read idempotent (the same bytes give the same ids) and
//! lets a backward page parse a window cold and get the events a forward
//! tail got. The one exception is [`ToolNames`]: a native rejection of
//! ExitPlanMode reads exactly like any other rejection, so the plan outcome
//! needs the tool's name from its `tool_use` line. A page window that splits
//! the two still gets the `tool_result`; only the derived `plan_outcome` is
//! lost, and the `tool_use` row already names the tool.
//!
//! What a line becomes:
//!
//! | Line | Events |
//! |---|---|
//! | `user`, a typed prompt (string or text blocks) | `user_text` (a long paste's `<pasted_content>` wrapper removed) |
//! | `user`, `[Request interrupted by user…]` | `interrupted` |
//! | `user`, `tool_result` blocks | `tool_result` each, plus `plan_outcome` for ExitPlanMode |
//! | `user` / `system`, `<command-name>` | `user_text` "/cmd args" |
//! | `user` / `system`, `<local-command-stdout>` | `mode_change` for "Enabled plan mode", `model_seen` for "Set model to" / "Set effort level to", else nothing |
//! | `user`, meta / compact summary / `<task-notification>` / caveats | nothing |
//! | `assistant`, `text` | `assistant_text` |
//! | `assistant`, `thinking` / `redacted_thinking` | `thinking` (never the text) |
//! | `assistant`, `tool_use` | `tool_use`, plus `plan_proposed` for ExitPlanMode |
//! | `system` `turn_duration` | `turn_end` |
//! | `system` `compact_boundary` | `compact` |
//! | `queue-operation` | `queued` |
//! | `permission-mode` | `mode_change` (written at every prompt, so it repeats; the stage compares) |
//! | `attachment` `model` | `model_seen` |
//! | `ai-title` | no event; returned as the session's title |
//! | everything else (`api-request*`, `file-history-*`, `attachment`s, `last-prompt`, sidechains) | nothing |

use std::collections::HashMap;

use serde_json::Value;

use super::wire::{Body, ConvoEvent};

/// Tool-result previews are a glance; the terminal has the rest.
const PREVIEW_CHARS: usize = 300;
/// The tool-name memory a plan outcome needs, bounded so a long session
/// can't grow it without limit.
const TOOL_NAMES_CAP: usize = 512;

/// Line types that never become events, recognised by their first bytes so a
/// multi-megabyte request blob is skipped without being parsed. These lines
/// start with their `type` key; conversation lines start with `parentUuid`.
const SKIPPED_PREFIXES: [&str; 7] = [
    "{\"type\":\"api-request",
    "{\"type\":\"file-history",
    "{\"type\":\"cost-state\"",
    "{\"type\":\"last-prompt\"",
    "{\"type\":\"atis-latch\"",
    "{\"type\":\"agent-name\"",
    "{\"type\":\"mode\"",
];

/// `tool_use` id → tool name, for the results whose meaning depends on the
/// tool. See the module note.
#[derive(Default)]
pub struct ToolNames(HashMap<String, String>);

impl ToolNames {
    fn note(&mut self, id: &str, name: &str) {
        if self.0.len() >= TOOL_NAMES_CAP {
            self.0.clear();
        }
        self.0.insert(id.to_string(), name.to_string());
    }

    fn get(&self, id: &str) -> Option<&str> {
        self.0.get(id).map(String::as_str)
    }
}

/// One line's events, plus the session title when the line carries one.
#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    pub events: Vec<ConvoEvent>,
    pub title: Option<String>,
}

/// One transcript line → its events. `offset` is where the line starts in
/// its epoch's transcript; `fallback_ts` stamps lines that carry no
/// timestamp of their own.
pub fn parse_line(line: &str, epoch: u32, offset: u64, fallback_ts: i64, tools: &mut ToolNames) -> Parsed {
    let mut out = Parsed::default();
    if line.trim().is_empty() || SKIPPED_PREFIXES.iter().any(|p| line.starts_with(p)) {
        return out;
    }
    let Ok(row) = serde_json::from_str::<Value>(line) else {
        // A torn or foreign line: the tail never hands one over, so this is a
        // file somebody else wrote. Skip it rather than guess.
        return out;
    };
    if row.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return out;
    }
    let ts = row
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(crate::transcript::iso_millis)
        .unwrap_or(fallback_ts);
    let bodies = match row.get("type").and_then(Value::as_str) {
        Some("user") => user(&row, tools),
        Some("assistant") => assistant(&row, tools),
        Some("system") => system(&row),
        Some("queue-operation") => queued(&row),
        Some("permission-mode") => str_field(&row, "permissionMode")
            .map(|mode| vec![Body::ModeChange { mode: mode.to_string() }])
            .unwrap_or_default(),
        Some("attachment") => attachment(&row),
        Some("ai-title") => {
            out.title = str_field(&row, "aiTitle").map(str::to_string);
            Vec::new()
        }
        _ => Vec::new(),
    };
    let base = str_field(&row, "uuid").map_or_else(|| format!("@{epoch}:{offset}"), str::to_string);
    let several = bodies.len() > 1;
    out.events = bodies
        .into_iter()
        .enumerate()
        .map(|(i, body)| ConvoEvent {
            id: if several { format!("{base}:{i}") } else { base.clone() },
            epoch,
            offset,
            ts,
            body,
        })
        .collect();
    out
}

fn str_field<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn user(row: &Value, tools: &mut ToolNames) -> Vec<Body> {
    if row.get("isMeta").and_then(Value::as_bool) == Some(true)
        || row.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
    {
        return Vec::new();
    }
    let prompt_id = str_field(row, "promptId").map(str::to_string);
    let content = row.pointer("/message/content");
    if let Some(blocks) = content.and_then(Value::as_array) {
        let results: Vec<Body> = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
            .flat_map(|b| tool_result(row, b, tools))
            .collect();
        if !results.is_empty() {
            return results;
        }
    }
    let text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return Vec::new(),
    };
    let trimmed = text.trim();
    if trimmed.starts_with("[Request interrupted by user") {
        return vec![Body::Interrupted];
    }
    if let Some(command) = slash_command(trimmed) {
        return vec![Body::UserText { text: command, prompt_id }];
    }
    if let Some(output) = trimmed.strip_prefix(LOCAL_OUTPUT) {
        return local_output(output);
    }
    // The CLI's own turns and notes: a finished background task, the caveat
    // and output around a slash command. None of them is something you said.
    if trimmed.is_empty()
        || ["<task-notification>", "<local-command-", "<bash-", "<system-reminder>"].iter().any(|p| trimmed.starts_with(p))
    {
        return Vec::new();
    }
    vec![Body::UserText { text: unwrap_pastes(&text), prompt_id }]
}

/// `<command-name>/model</command-name> … <command-args>sonnet</command-args>`
/// → `/model sonnet`.
fn slash_command(text: &str) -> Option<String> {
    let between = |open: &str, close: &str| {
        let start = text.find(open)? + open.len();
        let end = text[start..].find(close)? + start;
        Some(text[start..end].trim().to_string())
    };
    if !text.starts_with("<command-name>") && !text.starts_with("<command-message>") {
        return None;
    }
    let name = between("<command-name>", "</command-name>")?;
    let args = between("<command-args>", "</command-args>").unwrap_or_default();
    let name = if name.starts_with('/') { name } else { format!("/{name}") };
    Some(if args.is_empty() { name } else { format!("{name} {args}") })
}

const LOCAL_OUTPUT: &str = "<local-command-stdout>";

/// What a slash command printed, where it confirms a switch the stage asked
/// for (experiment (m), S7/S8). `/effort` prints no model, so its
/// `model_seen` carries an empty one: "unchanged".
fn local_output(output: &str) -> Vec<Body> {
    let output = output.trim_start();
    if output.starts_with("Enabled plan mode") {
        return vec![Body::ModeChange { mode: "plan".to_string() }];
    }
    if let Some(rest) = output.strip_prefix("Set model to ") {
        let name = rest.trim_start_matches('`');
        let name = name.split(['`', '<']).next().unwrap_or_default().trim();
        if !name.is_empty() {
            return vec![Body::ModelSeen { model: name.to_string(), effort: None }];
        }
    }
    if let Some(rest) = output.strip_prefix("Set effort level to ") {
        let level: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        if !level.is_empty() {
            return vec![Body::ModelSeen { model: String::new(), effort: Some(level) }];
        }
    }
    Vec::new()
}

/// A long paste reaches the transcript wrapped as
/// `\n\n<pasted_content id="x">\n…\n</pasted_content id="x">\n`, with its
/// tabs expanded (experiment (m), S6). Show what was pasted.
pub fn unwrap_pastes(text: &str) -> String {
    const OPEN: &str = "<pasted_content id=\"";
    if !text.contains(OPEN) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        let after = &rest[start + OPEN.len()..];
        let Some(id_end) = after.find("\">") else { break };
        let id = &after[..id_end];
        let close = format!("</pasted_content id=\"{id}\">");
        let body = &after[id_end + 2..];
        let Some(end) = body.find(&close) else { break };
        let inner = &body[..end];
        let inner = inner.strip_prefix('\n').unwrap_or(inner);
        out.push_str(&rest[..start]);
        out.push_str(inner.strip_suffix('\n').unwrap_or(inner));
        rest = &body[end + close.len()..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn tool_result(row: &Value, block: &Value, tools: &ToolNames) -> Vec<Body> {
    let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else { return Vec::new() };
    let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    let text = result_text(block);
    let mut out = vec![Body::ToolResult {
        tool_use_id: id.to_string(),
        is_error,
        preview: crate::transcript::preview(&text, PREVIEW_CHARS),
    }];
    if let Some(outcome) = plan_outcome(row, &text, is_error, tools.get(id)) {
        out.push(Body::PlanOutcome { tool_use_id: id.to_string(), outcome: outcome.0.to_string(), feedback: outcome.1 });
    }
    out
}

/// How an ExitPlanMode call ended, from its result:
/// - approved: the result carries the plan (`toolUseResult.plan`);
/// - feedback: a PreToolUse hook (Redline's review) denied it with a reason;
/// - denied: rejected in the TUI, with what the user typed if anything.
fn plan_outcome(row: &Value, text: &str, is_error: bool, tool: Option<&str>) -> Option<(&'static str, Option<String>)> {
    const HOOK_DENIAL: &str = "PreToolUse:ExitPlanMode hook error:";
    const SAID: &str = "the user said:\n";
    if !is_error && row.pointer("/toolUseResult/plan").is_some_and(Value::is_string) {
        return Some(("approved", None));
    }
    if let Some(reason) = text.strip_prefix(HOOK_DENIAL) {
        return Some(("feedback", Some(reason.trim().to_string()).filter(|r| !r.is_empty())));
    }
    if tool != Some("ExitPlanMode") || !is_error {
        return None;
    }
    match text.split_once(SAID) {
        Some((_, said)) => Some(("feedback", Some(said.trim().to_string()))),
        None => Some(("denied", None)),
    }
}

fn assistant(row: &Value, tools: &mut ToolNames) -> Vec<Body> {
    let Some(blocks) = row.pointer("/message/content").and_then(Value::as_array) else { return Vec::new() };
    let model = row.pointer("/message/model").and_then(Value::as_str).filter(|m| !m.starts_with('<')).map(str::to_string);
    let mut out = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = block.get("text").and_then(Value::as_str).unwrap_or_default();
                if !text.trim().is_empty() {
                    out.push(Body::AssistantText { text: text.to_string(), model: model.clone() });
                }
            }
            Some("thinking" | "redacted_thinking") => out.push(Body::Thinking),
            Some("tool_use") => {
                let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                tools.note(id, name);
                out.push(Body::ToolUse { tool_use_id: id.to_string(), name: name.to_string(), summary: tool_summary(name, &input) });
                if name == "ExitPlanMode" {
                    out.push(Body::PlanProposed {
                        tool_use_id: id.to_string(),
                        session_id: str_field(row, "sessionId").unwrap_or_default().to_string(),
                        title: input.get("plan").and_then(Value::as_str).and_then(plan_title),
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// A tool call in one line: `transcript::summarize_tool_input`, except for the two
/// tools whose input is a document (a plan, a question form). Permission
/// cards use the same summarizer, which is how a card finds its row.
fn tool_summary(name: &str, input: &Value) -> String {
    let text = match name {
        "ExitPlanMode" => input.get("plan").and_then(Value::as_str).and_then(plan_title),
        "AskUserQuestion" => input.pointer("/questions/0/question").and_then(Value::as_str).map(str::to_string),
        _ => None,
    };
    text.unwrap_or_else(|| crate::transcript::summarize_tool_input(input))
}

/// A plan's title: its first heading, else its first line with words. HTML
/// comments (a revision's `REDLINE_RESOLUTIONS` block) are not the plan.
pub fn plan_title(plan: &str) -> Option<String> {
    let mut plan = plan.to_string();
    while let Some(start) = plan.find("<!--") {
        match plan[start..].find("-->") {
            Some(end) => plan.replace_range(start..start + end + 3, ""),
            None => plan.truncate(start),
        }
    }
    let lines = || plan.lines().map(str::trim).filter(|l| !l.is_empty());
    let line = lines().find(|l| l.starts_with('#')).or_else(|| lines().find(|l| l.chars().any(char::is_alphanumeric)))?;
    let title = line.trim_start_matches('#').trim();
    (!title.is_empty()).then(|| crate::transcript::preview(title, 120))
}

fn system(row: &Value) -> Vec<Body> {
    match row.get("subtype").and_then(Value::as_str) {
        Some("turn_duration") => vec![Body::TurnEnd { duration_ms: row.get("durationMs").and_then(Value::as_u64) }],
        Some("compact_boundary") => vec![Body::Compact {
            trigger: row.pointer("/compactMetadata/trigger").and_then(Value::as_str).map(str::to_string),
        }],
        // Some slash commands record themselves as system lines instead.
        Some("local_command") => {
            let content = str_field(row, "content").unwrap_or_default().trim();
            if let Some(command) = slash_command(content) {
                vec![Body::UserText { text: command, prompt_id: None }]
            } else {
                content.strip_prefix(LOCAL_OUTPUT).map(local_output).unwrap_or_default()
            }
        }
        _ => Vec::new(),
    }
}

fn queued(row: &Value) -> Vec<Body> {
    let Some(op) = str_field(row, "operation") else { return Vec::new() };
    vec![Body::Queued {
        op: op.to_string(),
        text: str_field(row, "content").map(str::to_string),
        reason: str_field(row, "reason").map(str::to_string),
    }]
}

fn attachment(row: &Value) -> Vec<Body> {
    let Some(attachment) = row.get("attachment") else { return Vec::new() };
    match attachment.get("type").and_then(Value::as_str) {
        Some("model") => attachment
            .pointer("/identity/modelId")
            .and_then(Value::as_str)
            .map(|model| vec![Body::ModelSeen { model: model.to_string(), effort: None }])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}
