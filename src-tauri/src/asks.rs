// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Permission and question cards: a CLI's asks, answered in the session
//! stage instead of its terminal dialog.
//!
//! Two command hooks POST here (`POST /v1/term/ask`, installed with the
//! terminal hooks in `hook.rs`): `PermissionRequest` for every tool, and
//! `PreToolUse` for `AskUserQuestion`. Each is
//! `[ -n "${REDLINE_TERMINAL_ID:-}" ] || exit 0; curl -sf … || true`, so a
//! session outside the dock, a closed Redline and an HTTP error all print
//! nothing, and an empty reply is no decision: the TUI asks on its own.
//!
//! What experiment (m) measured, and what follows from it:
//! - **A permission dialog is never held hostage (S4).** The TUI draws its
//!   own dialog while the hook is still running; whichever answers first
//!   wins. A card answer dismisses the dialog; an answer typed in the TUI
//!   runs the tool and leaves the hook running, so the card closes when the
//!   tail sees the tool's result (`convo::read`). Esc rejects and kills the
//!   hook (about 100 ms), as does the hook's `timeout`, after which the
//!   dialog still works.
//! - **A question is held (S5 follow-up).** While its PreToolUse hook runs
//!   the TUI shows a spinner and no card; the card appears once the hook
//!   releases or times out. So questions are held for minutes, permissions
//!   for an hour.
//! - A card arms only while the terminal is bound to the asking session and
//!   a conversation is subscribed (`convo::open_ask`); otherwise `{}`.
//! - ExitPlanMode's PreToolUse hook (`/v1/plan`) owns the plan, and its
//!   approval now carries the call's own input as `updatedInput`, which is
//!   what spares it the CLI's "Ready to code? Would you like to proceed?"
//!   prompt (lib.rs `answer_for_build`). Measured 2026-10-28 on claude
//!   2.1.312 (fresh and `--resume`): an `allow` WITHOUT `updatedInput` —
//!   PreToolUse or PermissionRequest alike — leaves that prompt up for a
//!   person; WITH it the prompt never shows. So the PermissionRequest that
//!   comes with the prompt (when something else raised it) is answered here
//!   with `updatedInput` too: approved in Redline a moment before
//!   ([`note_plan_approved`]) it is allowed at once, with the payload's own
//!   mode switch when it offers one (it offered none on 2.1.312); otherwise
//!   it becomes a card ("Ready to build this plan?") whose Yes carries the
//!   input as well. A PermissionRequest for AskUserQuestion (it fires when
//!   the question was released to the TUI) passes through.
//!
//! A hold that ends without a stage answer (the connection dropped, the
//! hold ran out) closes its card through [`AskGuard`], modelled on the
//! review hold's `ReviewDetachGuard`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::convo::{self, AskAnswer, AskOption, AskQuestion, ConvoAsk, PendingAsk, Replier};

/// The hook `timeout`s `hook.rs` installs, in seconds, and the daemon's own
/// holds just inside them, so a hold that runs out answers `{}` cleanly
/// instead of being killed.
pub const PERMISSION_TIMEOUT_SECS: u64 = 3600;
pub const QUESTION_TIMEOUT_SECS: u64 = 300;
const HOLD_MARGIN: Duration = Duration::from_secs(10);
/// A card shows the tool input; long strings (a file's new content) are cut.
const INPUT_STRING_CHARS: usize = 2000;
const DEFAULT_DENIAL: &str = "Denied in Redline.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Permission,
    Question,
}

/// An ask hook's payload, as a card.
#[derive(Debug, Clone, PartialEq)]
struct Request {
    kind: Kind,
    tool_name: String,
    session_id: String,
    input: Value,
    suggestions: Option<Vec<Value>>,
    tool_use_id: Option<String>,
}

impl Request {
    fn from_payload(payload: &Value) -> Option<Self> {
        let text = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let tool_name = text("tool_name");
        let kind = match payload.get("hook_event_name").and_then(Value::as_str)? {
            "PermissionRequest" => Kind::Permission,
            "PreToolUse" if tool_name == "AskUserQuestion" => Kind::Question,
            _ => return None,
        };
        Some(Self {
            kind,
            tool_name,
            session_id: text("session_id"),
            input: payload.get("tool_input").cloned().unwrap_or(Value::Null),
            suggestions: payload.get("permission_suggestions").and_then(Value::as_array).cloned(),
            tool_use_id: Some(text("tool_use_id")).filter(|id| !id.is_empty()),
        })
    }

    /// Asks the stage leaves to their own hooks and dialogs (module note).
    fn passes_through(&self) -> bool {
        self.kind == Kind::Permission && self.tool_name == "AskUserQuestion"
    }

    /// The CLI asking leave to build a plan Redline just approved.
    fn is_approved_plan_exit(&self) -> bool {
        self.kind == Kind::Permission && self.tool_name == "ExitPlanMode" && take_plan_approved(&self.session_id)
    }

    fn hold(&self) -> Duration {
        let secs = match self.kind {
            Kind::Permission => PERMISSION_TIMEOUT_SECS,
            Kind::Question => QUESTION_TIMEOUT_SECS,
        };
        Duration::from_secs(secs) - HOLD_MARGIN
    }

    fn card(&self, ask_id: String) -> ConvoAsk {
        let questions = (self.kind == Kind::Question).then(|| questions(&self.input));
        let summary = match questions.as_ref().and_then(|q| q.first()) {
            Some(first) => first.question.clone(),
            None => crate::transcript::summarize_tool_input(&self.input),
        };
        ConvoAsk {
            ask_id,
            kind: match self.kind {
                Kind::Permission => "permission",
                Kind::Question => "question",
            }
            .to_string(),
            tool_name: self.tool_name.clone(),
            summary,
            input: (self.kind == Kind::Permission).then(|| trim_strings(&self.input)),
            suggestions: self.suggestions.clone(),
            rule: self.suggestions.as_deref().and_then(rule),
            questions,
            opened_at: crate::state::now_millis(),
        }
    }
}

fn questions(input: &Value) -> Vec<AskQuestion> {
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    input
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|q| {
            Some(AskQuestion {
                question: text(q, "question")?,
                header: text(q, "header"),
                multi_select: q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                options: q
                    .get("options")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|o| Some(AskOption { label: text(o, "label")?, description: text(o, "description") }))
                    .collect(),
            })
        })
        .collect()
}

/// The tool input with every long string cut, so a card for a big Write
/// doesn't carry the whole file.
fn trim_strings(value: &Value) -> Value {
    match value {
        Value::String(s) if s.chars().count() > INPUT_STRING_CHARS => {
            Value::String(format!("{}…", s.chars().take(INPUT_STRING_CHARS).collect::<String>()))
        }
        Value::Array(items) => Value::Array(items.iter().map(trim_strings).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), trim_strings(v))).collect()),
        other => other.clone(),
    }
}

/// The payload's own `permission_suggestions` as the sentence the card puts
/// beside Always: what picking it will change, and where.
fn rule(suggestions: &[Value]) -> Option<String> {
    let scope = |s: &Value| match s.get("destination").and_then(Value::as_str) {
        Some("session") => "for this session",
        Some("userSettings") => "everywhere",
        _ => "in this project",
    };
    let parts: Vec<String> = suggestions
        .iter()
        .filter_map(|s| match s.get("type").and_then(Value::as_str)? {
            "addRules" | "replaceRules" => {
                let rules: Vec<String> = s
                    .get("rules")
                    .and_then(Value::as_array)?
                    .iter()
                    .filter_map(|r| {
                        let tool = r.get("toolName").and_then(Value::as_str)?;
                        Some(match r.get("ruleContent").and_then(Value::as_str) {
                            Some(content) => format!("{tool}({content})"),
                            None => tool.to_string(),
                        })
                    })
                    .collect();
                let verb = match s.get("behavior").and_then(Value::as_str) {
                    Some("deny") => "Always deny",
                    Some("ask") => "Always ask for",
                    _ => "Always allow",
                };
                (!rules.is_empty()).then(|| format!("{verb} {} {}", rules.join(", "), scope(s)))
            }
            "addDirectories" => {
                let dirs: Vec<&str> = s.get("directories").and_then(Value::as_array)?.iter().filter_map(Value::as_str).collect();
                (!dirs.is_empty()).then(|| format!("Allow access to {} {}", dirs.join(", "), scope(s)))
            }
            "setMode" => {
                let mode = s.get("mode").and_then(Value::as_str)?;
                Some(format!("Switch to {} mode {}", mode_name(mode), scope(s)))
            }
            _ => None,
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

fn mode_name(mode: &str) -> &str {
    match mode {
        "acceptEdits" => "accept-edits",
        "bypassPermissions" => "bypass-permissions",
        "default" => "manual",
        other => other,
    }
}

// ── Approve & build answers the CLI's own proceed dialog ─────────────────────

/// How long an approval answers the PermissionRequest that follows it. The
/// request lands within a second or two of the PreToolUse `allow` (the CLI
/// asks right after the hook returns); a minute leaves room for a slow
/// machine and none for a later, unrelated ExitPlanMode.
const APPROVAL_WINDOW: Duration = Duration::from_secs(60);

fn approvals() -> &'static Mutex<HashMap<String, Instant>> {
    static APPROVALS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Redline just let `session_id`'s ExitPlanMode through (Approve & build, an
/// Ambient auto-approve): the CLI's proceed dialog that follows is answered
/// for the reviewer, once.
pub(crate) fn note_plan_approved(session_id: &str) {
    let mut map = approvals().lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, at| at.elapsed() < APPROVAL_WINDOW);
    map.insert(session_id.to_string(), Instant::now());
}

/// One-shot: true when `session_id` was approved within the window.
fn take_plan_approved(session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    let mut map = approvals().lock().unwrap_or_else(|e| e.into_inner());
    map.remove(session_id).is_some_and(|at| at.elapsed() < APPROVAL_WINDOW)
}

/// The reply that lets an approved plan's ExitPlanMode run: allow, switching
/// to the mode the dialog's first choice would (the payload's own `setMode`
/// suggestion), or accept-edits when the payload offers none.
/// `updatedInput` (the request's own input) is what makes the allow the
/// person's answer on claude 2.1.312 (module note); without it the CLI
/// ignores the allow and the prompt stays.
fn plan_approved_reply(suggestions: Option<&[Value]>, input: &Value) -> Value {
    let set_mode = suggestions
        .and_then(|all| all.iter().find(|s| s.get("type").and_then(Value::as_str) == Some("setMode")).cloned())
        .unwrap_or_else(|| json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"}));
    json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow", "updatedInput": input, "updatedPermissions": [set_mode]}}})
}

/// A permission card's allow: ExitPlanMode's carries its input back as
/// `updatedInput`, or the CLI keeps its own prompt up (module note).
fn allow_decision(pending: &PendingAsk, always: bool) -> Value {
    let mut decision = json!({"behavior": "allow"});
    if always {
        decision["updatedPermissions"] = json!(pending.ask.suggestions.clone().unwrap_or_default());
    }
    if pending.ask.tool_name == "ExitPlanMode" && pending.input.is_object() {
        decision["updatedInput"] = pending.input.clone();
    }
    decision
}

/// The hook's reply for a stage answer, and the outcome it records. The
/// shapes are the CLI's (experiment (m), S4/S5):
/// - permission: `hookSpecificOutput.decision` = `{behavior: allow}`, plus
///   `updatedPermissions` (the payload's suggestions, verbatim) for Always;
///   a deny with no message interrupts the turn, as the TUI's own "No" does;
/// - question: PreToolUse `allow` with `updatedInput` = the input plus
///   `answers` (question text → label);
/// - `terminal`: `{}`, so the TUI asks itself.
///
/// A Codex approval is answered on its app-server request instead
/// (`convo::codex::reply`).
pub(crate) fn reply(pending: &PendingAsk, answer: &AskAnswer) -> Result<(Value, &'static str), String> {
    if let Replier::Codex(_) = pending.reply {
        return convo::codex::reply(&pending.ask, answer);
    }
    let question = pending.ask.kind == "question";
    let permission = |decision: Value| json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}});
    Ok(match (question, answer) {
        (_, AskAnswer::Terminal) => (json!({}), "terminal"),
        (false, AskAnswer::Allow) => (permission(allow_decision(pending, false)), "allow"),
        (false, AskAnswer::Always) => (permission(allow_decision(pending, true)), "always"),
        (false, AskAnswer::Deny { message }) => {
            let decision = match message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
                Some(message) => json!({"behavior": "deny", "message": message}),
                None => json!({"behavior": "deny", "message": DEFAULT_DENIAL, "interrupt": true}),
            };
            (permission(decision), "deny")
        }
        (true, AskAnswer::Answers { answers }) => {
            let mut input = pending.input.clone();
            if let Some(map) = input.as_object_mut() {
                map.insert("answers".into(), json!(answers));
            } else {
                input = json!({"answers": answers});
            }
            (
                json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": input}}),
                "answered",
            )
        }
        (true, AskAnswer::Deny { message }) => {
            let reason = message.clone().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "The user declined to answer.".into());
            (
                json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}),
                "deny",
            )
        }
        (true, _) => return Err("a question takes answers, a denial, or the terminal".into()),
        (false, AskAnswer::Answers { .. }) => return Err("a permission takes allow, always, deny, or the terminal".into()),
    })
}

/// Held for the life of an ask's hook request. On drop (answered, timed
/// out, or the hook's connection gone) it closes the card if the stage
/// never answered it.
struct AskGuard {
    app: AppHandle,
    terminal_id: String,
    ask_id: String,
}

impl Drop for AskGuard {
    fn drop(&mut self) {
        convo::drop_ask(&self.app, &self.terminal_id, &self.ask_id);
    }
}

/// POST `/v1/term/ask`: hold an ask until the stage answers it, or answer
/// `{}` at once when it can't be shown.
pub(crate) async fn handle_ask(
    State(app_state): State<crate::AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let empty = || Json(json!({}));
    let Some(terminal_id) = crate::term_attention::terminal_header(&headers) else { return empty() };
    let Some(request) = Request::from_payload(&payload) else { return empty() };
    if request.passes_through() {
        return empty();
    }
    if request.is_approved_plan_exit() {
        tracing::info!(session_id = %request.session_id, "answering the CLI's proceed dialog for a plan approved in Redline");
        return Json(plan_approved_reply(request.suggestions.as_deref(), &request.input));
    }
    let app = app_state.app_handle.clone();
    let ask_id = uuid::Uuid::new_v4().to_string();
    let card = request.card(ask_id.clone());
    let Some(rx) = convo::open_ask(&app, &terminal_id, &request.session_id, card, request.tool_use_id.clone(), request.input.clone())
    else {
        return empty();
    };
    let _guard = AskGuard { app, terminal_id, ask_id };
    match tokio::time::timeout(request.hold(), rx).await {
        Ok(Ok(reply)) => Json(reply),
        _ => empty(),
    }
}

/// The stage's answer to a card.
#[tauri::command]
pub fn convo_answer_ask(app: AppHandle, ask_id: String, answer: AskAnswer) -> Result<(), String> {
    convo::answer_ask(&app, &ask_id, |pending| reply(pending, &answer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::sync::oneshot;

    /// Captured from claude 2.1.302 by `scripts/verify-convo-mirror.py`
    /// (paths shortened): a Bash permission ask.
    const PERMISSION: &str = r#"{"session_id":"458feddb-24bc-4c69-af98-96b727d6129f","transcript_path":"/Users/u/.claude/projects/-tmp-proj/458feddb-24bc-4c69-af98-96b727d6129f.jsonl","cwd":"/tmp/proj","prompt_id":"5c1e","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"touch a-allow.txt","description":"Create empty file a-allow.txt"},"permission_suggestions":[{"type":"addDirectories","directories":["/tmp/proj"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"scratchpad_dir":"/tmp/s"}"#;
    /// The same run's AskUserQuestion, at its PreToolUse hook.
    const QUESTION: &str = r#"{"session_id":"458feddb-24bc-4c69-af98-96b727d6129f","transcript_path":"/Users/u/.claude/projects/-tmp-proj/458feddb-24bc-4c69-af98-96b727d6129f.jsonl","cwd":"/tmp/proj","prompt_id":"77aa","permission_mode":"acceptEdits","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which color do you prefer?","header":"Color","options":[{"label":"Red","description":"Choose red"},{"label":"Blue","description":"Choose blue"}],"multiSelect":false}]},"tool_use_id":"toolu_01Q","scratchpad_dir":"/tmp/s"}"#;

    fn pending(payload: &str) -> (PendingAsk, oneshot::Receiver<Value>) {
        let request = Request::from_payload(&serde_json::from_str(payload).unwrap()).unwrap();
        let (tx, rx) = oneshot::channel();
        (PendingAsk { ask: request.card("a1".into()), tool_use_id: request.tool_use_id.clone(), input: request.input.clone(), reply: Replier::Hook(tx) }, rx)
    }

    #[test]
    fn a_permission_payload_becomes_a_card() {
        let (p, _) = pending(PERMISSION);
        assert_eq!(p.ask.kind, "permission");
        assert_eq!(p.ask.tool_name, "Bash");
        assert_eq!(p.ask.summary, "touch a-allow.txt", "the transcript summarizer's one line");
        assert_eq!(p.ask.input.as_ref().unwrap()["command"], "touch a-allow.txt");
        assert_eq!(p.ask.suggestions.as_ref().unwrap().len(), 2);
        assert_eq!(
            p.ask.rule.as_deref(),
            Some("Allow access to /tmp/proj for this session; Switch to accept-edits mode for this session")
        );
        assert_eq!(p.tool_use_id, None, "a PermissionRequest names no tool call (S4)");
        assert!(p.ask.questions.is_none());
    }

    #[test]
    fn a_question_payload_becomes_a_card_with_its_options() {
        let (p, _) = pending(QUESTION);
        assert_eq!(p.ask.kind, "question");
        assert_eq!(p.ask.summary, "Which color do you prefer?");
        assert_eq!(p.tool_use_id.as_deref(), Some("toolu_01Q"));
        let q = &p.ask.questions.as_ref().unwrap()[0];
        assert_eq!((q.header.as_deref(), q.multi_select), (Some("Color"), false));
        assert_eq!(q.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Red", "Blue"]);
        assert!(p.ask.input.is_none());
    }

    /// The exact JSON each answer sends the CLI (S4, S5 and the follow-ups).
    #[test]
    fn every_answer_has_its_exact_reply() {
        let (perm, _) = pending(PERMISSION);
        let decision = |answer: AskAnswer| reply(&perm, &answer).unwrap();
        assert_eq!(decision(AskAnswer::Allow), (json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}), "allow"));
        assert_eq!(
            decision(AskAnswer::Always).0,
            json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow", "updatedPermissions": [
                {"type": "addDirectories", "directories": ["/tmp/proj"], "destination": "session"},
                {"type": "setMode", "mode": "acceptEdits", "destination": "session"}
            ]}}})
        );
        assert_eq!(
            decision(AskAnswer::Deny { message: Some("Use npm ci instead".into()) }).0,
            json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "Use npm ci instead"}}})
        );
        assert_eq!(
            decision(AskAnswer::Deny { message: None }).0,
            json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "Denied in Redline.", "interrupt": true}}}),
            "a bare deny stops the turn like the TUI's No"
        );
        assert_eq!(decision(AskAnswer::Terminal), (json!({}), "terminal"));
        assert!(reply(&perm, &AskAnswer::Answers { answers: HashMap::new() }).is_err());

        let (question, _) = pending(QUESTION);
        let answers = HashMap::from([("Which color do you prefer?".to_string(), "Blue".to_string())]);
        let (json, outcome) = reply(&question, &AskAnswer::Answers { answers }).unwrap();
        assert_eq!(outcome, "answered");
        assert_eq!(json["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(json["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(json["hookSpecificOutput"]["updatedInput"]["answers"], json!({"Which color do you prefer?": "Blue"}));
        assert_eq!(json["hookSpecificOutput"]["updatedInput"]["questions"][0]["header"], "Color", "the input goes back whole");
        assert_eq!(reply(&question, &AskAnswer::Deny { message: None }).unwrap().0["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(reply(&question, &AskAnswer::Allow).is_err());
    }

    #[test]
    fn an_approved_plan_exit_is_allowed_once_with_the_dialogs_mode_and_an_unapproved_one_is_a_card() {
        let parse = |v: Value| Request::from_payload(&v).unwrap();
        let exit = |sid: &str| parse(json!({"hook_event_name": "PermissionRequest", "tool_name": "ExitPlanMode", "session_id": sid}));
        // Not approved: no longer passed through — it becomes a card.
        assert!(!exit("asks-test-unapproved").passes_through());
        assert!(!exit("asks-test-unapproved").is_approved_plan_exit());
        note_plan_approved("asks-test-approved");
        assert!(exit("asks-test-approved").is_approved_plan_exit());
        assert!(!exit("asks-test-approved").is_approved_plan_exit(), "one approval answers one dialog");
        // Another tool of the same session is untouched by the approval.
        note_plan_approved("asks-test-bash");
        let bash = parse(json!({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "session_id": "asks-test-bash"}));
        assert!(!bash.is_approved_plan_exit());
        assert!(!exit("").is_approved_plan_exit());
        // The payload's own mode switch, else accept-edits; and the call's own
        // input back as `updatedInput`, without which claude 2.1.312 ignores
        // the allow and keeps its "Ready to code?" prompt up.
        let input = json!({"plan": "# Plan", "planFilePath": "/p/plan.md"});
        let offered = [json!({"type": "addDirectories", "directories": ["/x"]}), json!({"type": "setMode", "mode": "auto", "destination": "session"})];
        assert_eq!(
            plan_approved_reply(Some(&offered), &input),
            json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow", "updatedInput": {"plan": "# Plan", "planFilePath": "/p/plan.md"}, "updatedPermissions": [{"type": "setMode", "mode": "auto", "destination": "session"}]}}})
        );
        assert_eq!(plan_approved_reply(None, &input)["hookSpecificOutput"]["decision"]["updatedPermissions"][0]["mode"], "acceptEdits");
    }

    #[test]
    fn the_ready_to_build_cards_yes_carries_the_plan_exits_input() {
        let payload = json!({"hook_event_name": "PermissionRequest", "tool_name": "ExitPlanMode", "session_id": "s", "tool_input": {"plan": "# Plan", "planFilePath": "/p/plan.md"}});
        let request = Request::from_payload(&payload).unwrap();
        let (tx, _rx) = oneshot::channel();
        let exit = PendingAsk { ask: request.card("a1".into()), tool_use_id: None, input: request.input.clone(), reply: Replier::Hook(tx) };
        let (yes, outcome) = reply(&exit, &AskAnswer::Allow).unwrap();
        assert_eq!(outcome, "allow");
        assert_eq!(yes["hookSpecificOutput"]["decision"]["updatedInput"]["planFilePath"], "/p/plan.md");
        // Any other tool's allow is just an allow.
        let (bash, _) = pending(PERMISSION);
        assert!(reply(&bash, &AskAnswer::Allow).unwrap().0["hookSpecificOutput"]["decision"].get("updatedInput").is_none());
    }

    #[test]
    fn released_question_asks_pass_through() {
        let parse = |v: Value| Request::from_payload(&v).unwrap();
        assert!(parse(json!({"hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion"})).passes_through());
        assert!(!parse(json!({"hook_event_name": "PermissionRequest", "tool_name": "Bash"})).passes_through());
        assert!(!parse(json!({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion"})).passes_through());
        assert_eq!(Request::from_payload(&json!({"hook_event_name": "PreToolUse", "tool_name": "Bash"})), None, "only questions at PreToolUse");
        assert_eq!(Request::from_payload(&json!({"hook_event_name": "Stop"})), None);
    }

    #[test]
    fn rules_read_as_sentences_and_long_inputs_are_cut() {
        let rules = json!([{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test:*"}], "behavior": "allow", "destination": "localSettings"}]);
        assert_eq!(rule(rules.as_array().unwrap()).as_deref(), Some("Always allow Bash(npm test:*) in this project"));
        assert_eq!(rule(&[json!({"type": "unknown"})]), None);
        let big = trim_strings(&json!({"content": "x".repeat(5000), "n": 1}));
        assert_eq!(big["content"].as_str().unwrap().chars().count(), INPUT_STRING_CHARS + 1);
        assert_eq!(big["n"], 1);
    }

    #[test]
    fn holds_end_inside_the_hook_timeouts() {
        let parse = |v: &str| Request::from_payload(&serde_json::from_str(v).unwrap()).unwrap();
        assert!(parse(PERMISSION).hold() < Duration::from_secs(PERMISSION_TIMEOUT_SECS));
        assert!(parse(QUESTION).hold() < Duration::from_secs(QUESTION_TIMEOUT_SECS));
    }
}
