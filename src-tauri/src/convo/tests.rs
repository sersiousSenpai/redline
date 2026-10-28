// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The mirror's tests: golden fixtures cut from real transcripts, the read
//! invariants, and the per-terminal state machine.
//!
//! Each `tests/fixtures/convo/<name>.jsonl` is a slice of a transcript the
//! spike rig (`scripts/verify-convo-mirror.py`) captured from claude 2.1.302
//! in experiment (m), with paths, request bodies and account data scrubbed.
//! `<name>.events.json` is what the tail makes of it, and the frontend
//! reducer's tests read the same pair. `CONVO_BLESS=1 cargo test --lib
//! convo::tests` rewrites the `.events.json` files after a deliberate change.

use std::io::Write;
use std::path::Path;

use serde_json::json;
use tauri::ipc::InvokeResponseBody;

use super::claude::Parsed;
use super::*;

const FIXTURES: &str = "tests/fixtures/convo";

fn fixtures() -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::fs::read_dir(FIXTURES)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        // Codex's are app-server messages, not transcripts (`codex_tests`).
        .filter(|p| !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("codex_")))
        .collect();
    paths.sort();
    assert!(paths.len() >= 12, "the fixture set is missing: {paths:?}");
    paths
}

/// What the tail makes of a whole file: one read, timestamps as written (0
/// where a line has none), epoch 0.
fn tail_all(path: &Path) -> Vec<ConvoEvent> {
    tail::ClaudeSource::new(path.to_path_buf(), 0).poll(0).events
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rl-convo-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn kinds(events: &[ConvoEvent]) -> Vec<String> {
    events.iter().map(|e| serde_json::to_value(e).unwrap()["kind"].as_str().unwrap().to_string()).collect()
}

fn fixture_events(name: &str) -> Vec<ConvoEvent> {
    tail_all(&Path::new(FIXTURES).join(format!("{name}.jsonl")))
}

#[test]
fn golden_fixtures_match_their_events() {
    let bless = std::env::var_os("CONVO_BLESS").is_some();
    for path in fixtures() {
        let events = serde_json::to_value(tail_all(&path)).unwrap();
        let golden = path.with_extension("events.json");
        if bless {
            std::fs::write(&golden, format!("{}\n", serde_json::to_string_pretty(&events).unwrap())).unwrap();
            continue;
        }
        let want: Value = serde_json::from_str(&std::fs::read_to_string(&golden).unwrap_or_else(|_| panic!("{golden:?} missing; bless it")))
            .unwrap();
        assert_eq!(events, want, "{path:?} no longer reads as its golden events");
    }
}

/// The tail sees a file grow one byte at a time (a multibyte character, a
/// line, a 30 KB tool result torn at every position) and still produces
/// exactly the one-shot read's events.
#[test]
fn a_transcript_read_one_byte_at_a_time_gives_the_same_events() {
    let dir = scratch("bytes");
    for path in fixtures() {
        let bytes = std::fs::read(&path).unwrap();
        let grow = dir.join(path.file_name().unwrap());
        let mut file = std::fs::File::create(&grow).unwrap();
        let mut source = tail::ClaudeSource::new(grow.clone(), 0);
        let mut events = Vec::new();
        for byte in &bytes {
            file.write_all(std::slice::from_ref(byte)).unwrap();
            events.extend(source.poll(0).events);
        }
        assert_eq!(events, tail_all(&path), "{path:?}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

/// Paging back from the end, in windows of any size, gives back exactly the
/// forward read: no line cut, skipped or read twice.
#[test]
fn backward_pages_add_up_to_the_forward_read() {
    for path in fixtures() {
        let forward = tail_all(&path);
        let len = std::fs::metadata(&path).unwrap().len();
        for window in [300, 4096, 1 << 20] {
            let mut pages = Vec::new();
            let mut before = len;
            loop {
                let (events, start) = tail::page_with(&path, before, window);
                pages.push(events);
                if start == 0 {
                    break;
                }
                before = start;
            }
            let union: Vec<_> = pages.into_iter().rev().flatten().collect();
            assert_eq!(union, forward, "{path:?} in {window}-byte windows");
        }
    }
}

// --- what the fixtures say (the convo-ui lane's expectations) ------------------

#[test]
fn a_plan_turn_reads_as_prompt_tools_then_a_proposed_plan() {
    let events = fixture_events("plan_turn");
    let k = kinds(&events);
    assert_eq!(k.first().map(String::as_str), Some("mode_change"), "the mode line comes before the prompt");
    let prompt = k.iter().position(|k| k == "user_text").unwrap();
    let proposed = k.iter().position(|k| k == "plan_proposed").unwrap();
    assert!(prompt < proposed);
    assert_eq!(k[proposed - 1], "tool_use", "plan_proposed follows its ExitPlanMode tool_use");
    let Body::PlanProposed { session_id, title, tool_use_id } = &events[proposed].body else { unreachable!() };
    assert_eq!(session_id, "870509b9-ff25-4376-8f93-f9526dbd739c", "the id plan-received carries");
    assert!(title.is_some());
    assert_eq!(events[proposed - 1].id, format!("{}:0", events[proposed].id.trim_end_matches(":1")), "one line, two events: uuid:0, uuid:1");
    assert!(tool_use_id.starts_with("toolu_"));
}

#[test]
fn plan_outcomes_read_from_their_results() {
    let denied = fixture_events("plan_deny_feedback");
    let outcome = denied.iter().find_map(|e| match &e.body {
        Body::PlanOutcome { outcome, feedback, .. } => Some((outcome.clone(), feedback.clone())),
        _ => None,
    });
    let (outcome, feedback) = outcome.expect("the hook's denial is an outcome");
    assert_eq!(outcome, "feedback");
    assert!(feedback.unwrap().contains("add a step that verifies the file"));
    let approved = fixture_events("plan_approve");
    assert!(approved.iter().any(|e| matches!(&e.body, Body::PlanOutcome { outcome, .. } if outcome == "approved")));
    assert!(approved.iter().any(|e| matches!(&e.body, Body::ModeChange { mode } if mode == "auto")), "approval leaves plan mode");
    assert_eq!(kinds(&approved).last().map(String::as_str), Some("mode_change"));
    assert!(kinds(&approved).contains(&"turn_end".to_string()));
}

#[test]
fn interrupts_rejections_and_denials_read_distinctly() {
    let interrupt = kinds(&fixture_events("interrupt"));
    assert!(interrupt.ends_with(&["interrupted".to_string()]), "{interrupt:?}");
    let rejected = fixture_events("tool_rejection");
    let k = kinds(&rejected);
    let at = k.iter().position(|k| k == "tool_result").unwrap();
    assert_eq!(&k[at..], ["tool_result", "interrupted", "turn_end"]);
    assert!(matches!(&rejected[at].body, Body::ToolResult { is_error: true, .. }));
    let denied = fixture_events("permission_denied");
    assert!(denied.iter().any(|e| matches!(&e.body, Body::ToolResult { is_error: true, preview, .. } if preview.contains("Not now"))));
    assert!(!kinds(&denied).contains(&"interrupted".to_string()), "a denial with a message lets the turn go on");
}

#[test]
fn slash_commands_confirm_mode_and_model_switches() {
    let events = fixture_events("slash_commands");
    let texts: Vec<_> = events.iter().filter_map(|e| match &e.body { Body::UserText { text, .. } => Some(text.as_str()), _ => None }).collect();
    assert!(texts.contains(&"/plan") && texts.contains(&"/model sonnet") && texts.contains(&"/effort low"), "{texts:?}");
    assert!(events.iter().any(|e| matches!(&e.body, Body::ModeChange { mode } if mode == "plan")));
    let seen: Vec<_> = events.iter().filter_map(|e| match &e.body { Body::ModelSeen { model, effort } => Some((model.as_str(), effort.as_deref())), _ => None }).collect();
    assert!(seen.contains(&("Sonnet 5.5", None)), "{seen:?}");
    assert!(seen.contains(&("", Some("low"))), "/effort carries no model: {seen:?}");
    assert!(seen.contains(&("Haiku 5.5", None)));
}

#[test]
fn queues_notifications_pastes_and_compaction_read_as_the_cli_meant_them() {
    let queue = fixture_events("queue_operation");
    let ops: Vec<_> = queue.iter().filter_map(|e| match &e.body { Body::Queued { op, .. } => Some(op.as_str()), _ => None }).collect();
    assert_eq!(ops, ["enqueue", "dequeue"]);
    let absorbed = fixture_events("queue_absorbed");
    let ops: Vec<_> = absorbed.iter().filter_map(|e| match &e.body { Body::Queued { op, reason, .. } => Some((op.as_str(), reason.as_deref())), _ => None }).collect();
    assert_eq!(ops, [("enqueue", None), ("remove", Some("absorbed_mid_turn"))]);
    assert_eq!(absorbed.iter().filter(|e| matches!(e.body, Body::UserText { .. })).count(), 1, "the absorbed prompt has no line of its own");
    let notice = fixture_events("task_notification");
    assert!(
        notice.iter().all(|e| !matches!(&e.body, Body::UserText { text, .. } if text.contains("task-notification"))),
        "a finished background task is the CLI's turn, not something you said"
    );
    let paste = fixture_events("long_paste");
    let text = paste.iter().find_map(|e| match &e.body { Body::UserText { text, .. } => Some(text.clone()), _ => None }).unwrap();
    assert!(text.starts_with("Reply with the single word ok.") && !text.contains("pasted_content"));
    let compact = kinds(&fixture_events("compact"));
    assert!(compact.contains(&"compact".to_string()));
    assert!(!fixture_events("compact").iter().any(|e| matches!(&e.body, Body::UserText { text, .. } if text.starts_with("This session is being continued"))));
    let clear = fixture_events("clear");
    assert!(matches!(&clear.iter().find(|e| matches!(e.body, Body::UserText { .. })).unwrap().body, Body::UserText { text, .. } if text == "/clear"));
}

#[test]
fn machine_lines_huge_results_and_a_torn_end_are_handled() {
    let blob = std::fs::read_to_string(Path::new(FIXTURES).join("api_request_blob.jsonl")).unwrap();
    assert!(blob.lines().any(|l| l.len() > 50_000 && l.starts_with("{\"type\":\"api-request")), "the fixture holds a big request line");
    assert!(fixture_events("api_request_blob").iter().all(|e| !e.id.is_empty()));
    let huge = fixture_events("huge_result");
    let preview = huge.iter().find_map(|e| match &e.body { Body::ToolResult { preview, .. } => Some(preview.clone()), _ => None }).unwrap();
    assert!(preview.chars().count() <= 301, "a result is a glance");
    let torn = std::fs::read_to_string(Path::new(FIXTURES).join("torn_last_line.jsonl")).unwrap();
    assert!(!torn.ends_with('\n'));
    let events = fixture_events("torn_last_line");
    let last_whole = torn.rfind('\n').unwrap() as u64;
    assert!(events.iter().all(|e| e.offset < last_whole), "the torn record is never parsed");
}

// --- one line at a time ------------------------------------------------------------

fn parse(line: Value) -> Parsed {
    claude::parse_line(&line.to_string(), 2, 77, 5, &mut claude::ToolNames::default())
}

#[test]
fn ids_are_the_line_uuid_suffixed_only_when_a_line_makes_several() {
    let one = parse(json!({"type": "assistant", "uuid": "u1", "message": {"content": [{"type": "text", "text": "hi"}]}}));
    assert_eq!(one.events[0].id, "u1");
    assert_eq!((one.events[0].epoch, one.events[0].offset, one.events[0].ts), (2, 77, 5), "no timestamp: the fallback");
    let two = parse(json!({"type": "user", "uuid": "u2", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "a", "content": "x"},
        {"type": "tool_result", "tool_use_id": "b", "content": [{"type": "text", "text": "y"}], "is_error": true}
    ]}}));
    assert_eq!(two.events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["u2:0", "u2:1"]);
    let mode = parse(json!({"type": "permission-mode", "permissionMode": "plan", "sessionId": "s"}));
    assert_eq!(mode.events[0].id, "@2:77", "no uuid: the line's place");
    assert_eq!(mode.events[0].body, Body::ModeChange { mode: "plan".into() });
    let stamped = parse(json!({"type": "system", "subtype": "turn_duration", "durationMs": 9, "uuid": "u3", "timestamp": "2026-10-18T08:16:01.791Z"}));
    assert_eq!(stamped.events[0].ts, crate::runwatch::iso_millis("2026-10-18T08:16:01.791Z").unwrap());
    assert_eq!(stamped.events[0].body, Body::TurnEnd { duration_ms: Some(9) });
}

#[test]
fn what_never_becomes_an_event() {
    for line in [
        json!({"type": "user", "isMeta": true, "message": {"content": "<local-command-caveat>x</local-command-caveat>"}}),
        json!({"type": "user", "isCompactSummary": true, "message": {"content": "This session is being continued"}}),
        json!({"type": "user", "message": {"content": "<task-notification>\n<task-id>x</task-id>"}}),
        json!({"type": "assistant", "isSidechain": true, "message": {"content": [{"type": "text", "text": "subagent"}]}}),
        json!({"type": "attachment", "attachment": {"type": "environment"}}),
        json!({"type": "system", "subtype": "stop_hook_summary"}),
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "  "}]}}),
    ] {
        assert_eq!(parse(line.clone()).events, Vec::new(), "{line}");
    }
    let mut tools = claude::ToolNames::default();
    assert_eq!(claude::parse_line("{\"type\":\"api-request-blob\",\"message\":", 0, 0, 0, &mut tools), Parsed::default(), "skipped unread");
    assert_eq!(claude::parse_line("not json", 0, 0, 0, &mut tools), Parsed::default());
    let titled = parse(json!({"type": "ai-title", "aiTitle": "Pong reply"}));
    assert_eq!((titled.events.len(), titled.title.as_deref()), (0, Some("Pong reply")));
}

#[test]
fn thinking_is_marked_never_mirrored() {
    let thought = parse(json!({"type": "assistant", "uuid": "t", "message": {"content": [{"type": "thinking", "thinking": "secret", "signature": "s"}]}}));
    assert_eq!(thought.events[0].body, Body::Thinking);
    assert!(!serde_json::to_string(&thought.events).unwrap().contains("secret"));
}

#[test]
fn a_native_rejection_of_a_plan_needs_its_tool_use() {
    let mut tools = claude::ToolNames::default();
    let line = |v: Value| v.to_string();
    claude::parse_line(&line(json!({"type": "assistant", "uuid": "a", "sessionId": "s", "message": {"content": [{"type": "tool_use", "id": "p1", "name": "ExitPlanMode", "input": {"plan": "<!-- x -->\n# Ship it\n\nsteps"}}]}})), 0, 0, 0, &mut tools);
    let reject = |text: &str| json!({"type": "user", "uuid": "r", "message": {"content": [{"type": "tool_result", "tool_use_id": "p1", "content": text, "is_error": true}]}});
    let outcome = |events: &[ConvoEvent]| events.iter().find_map(|e| match &e.body { Body::PlanOutcome { outcome, feedback, .. } => Some((outcome.clone(), feedback.clone())), _ => None });
    let plain = claude::parse_line(&line(reject("The user doesn't want to proceed with this tool use.")), 0, 1, 0, &mut tools);
    assert_eq!(outcome(&plain.events), Some(("denied".into(), None)));
    let said = claude::parse_line(&line(reject("The user doesn't want to proceed… To tell you how to proceed, the user said:\nfewer steps")), 0, 2, 0, &mut tools);
    assert_eq!(outcome(&said.events), Some(("feedback".into(), Some("fewer steps".into()))));
    let cold = parse(reject("The user doesn't want to proceed with this tool use."));
    assert_eq!(outcome(&cold.events), None, "without the tool_use it's just a failed tool");
    assert_eq!(claude::plan_title("<!-- REDLINE_RESOLUTIONS\n{\n  \"c-1\": \"done\"\n}\n-->\n# Ship it\n"), Some("Ship it".into()));
    assert_eq!(claude::plan_title("<!-- notes -->\nShip it now."), Some("Ship it now.".into()));
    assert_eq!(claude::plan_title("Just do it."), Some("Just do it.".into()));
}

#[test]
fn pastes_unwrap_and_match_keys_ignore_the_cli_rewrites() {
    let wrapped = "\n\n<pasted_content id=\"bac8\">\nline one\n0000    tab\n</pasted_content id=\"bac8\">\n";
    assert_eq!(claude::unwrap_pastes(wrapped), "line one\n0000    tab");
    assert_eq!(claude::unwrap_pastes("before <pasted_content id=\"a\">\nx\n</pasted_content id=\"a\"> after"), "before x after");
    assert_eq!(claude::unwrap_pastes("no paste"), "no paste");
    assert_eq!(match_key(wrapped), match_key("line one\n0000\ttab\n"), "the composer's text matches the CLI's rewrite");
    assert_ne!(match_key("one two"), match_key("one three"));
}

// --- the terminal ------------------------------------------------------------------

type Batches = Arc<Mutex<Vec<Value>>>;

fn recorder() -> (Channel<ConvoBatch>, Batches) {
    let got: Batches = Arc::default();
    let sink = got.clone();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            lock(&sink).push(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, got)
}

fn ready() -> Option<InputState> {
    Some(InputState { paste_mode: true, dirty: false, cli_foreground: true })
}

fn fire(source: &str, sid: &str, path: &Path) -> bind::Fire {
    bind::Fire { source: source.into(), session_id: sid.into(), transcript: path.to_path_buf(), starts: true, harness: bind::Harness::Claude }
}

/// Every event kind delivered so far, batch by batch flattened.
fn delivered(batches: &Batches) -> Vec<String> {
    lock(batches).iter().flat_map(|b| b["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect::<Vec<_>>()).collect()
}

fn flush_all(term: &mut Term) {
    for sub in &mut term.subs {
        sub.sent = None;
    }
    term.flush(Instant::now());
}

#[test]
fn binding_epochs_and_a_takeover_reach_the_stage() {
    let dir = scratch("bind");
    let first = dir.join("a.jsonl");
    let second = dir.join("b.jsonl");
    std::fs::copy(Path::new(FIXTURES).join("interrupt.jsonl"), &first).unwrap();
    std::fs::copy(Path::new(FIXTURES).join("clear.jsonl"), &second).unwrap();
    let mut term = Term::default();
    let (channel, batches) = recorder();
    let snapshot = term.subscribe(channel, ready());
    assert_eq!(kinds(&snapshot.events), ["readiness"], "a terminal with no CLI yet");
    assert_eq!(snapshot.events[0].body, Body::Readiness { ready: false, blocker: Some(Blocker::Unbound) });

    let bound = term.apply_fire(fire("startup", "a", &first)).unwrap();
    assert_eq!(bound.session_id, "a");
    term.read();
    term.refresh(ready());
    flush_all(&mut term);
    let got = delivered(&batches);
    assert_eq!(got.first().map(String::as_str), Some("bound"));
    assert!(got.contains(&"interrupted".to_string()) && got.last().map(String::as_str) == Some("readiness"), "{got:?}");

    // `/clear`: a divider, the new epoch's bound, then its lines.
    term.apply_fire(fire("clear", "b", &second));
    term.read();
    flush_all(&mut term);
    let got = delivered(&batches);
    let divider = got.iter().position(|k| k == "epoch").unwrap();
    assert_eq!(got[divider + 1], "bound");
    assert_eq!(term.epoch(), 1);
    let snapshot = term.snapshot(ready());
    assert!(snapshot.0.windows(2).all(|w| (w[0].epoch, w[0].offset) <= (w[1].epoch, w[1].offset) || matches!(w[1].body, Body::Readiness { .. })), "ordered by (epoch, offset)");
    // Paging back across the divider reaches the first transcript.
    let page = term.page(1, 0).unwrap();
    assert!(page.events.iter().all(|e| e.epoch == 0) && kinds(&page.events).contains(&"interrupted".to_string()));
    assert!(!page.has_older);
    assert!(term.page(0, 0).unwrap().events.is_empty());

    // A compact keeps the epoch and re-sends `bound`.
    term.apply_fire(fire("compact", "b", &second));
    assert_eq!(term.epoch(), 1);
    // Another `claude` started in the same terminal: the stage starts over.
    term.apply_fire(fire("startup", "c", &first));
    flush_all(&mut term);
    let last = lock(&batches).last().cloned().unwrap();
    assert_eq!(last["reset"], true);
    assert_eq!(last["events"][0]["kind"], "bound");
    assert_eq!(last["events"][0]["sessionId"], "c");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn readiness_names_the_first_thing_in_the_way() {
    let mut term = Term::default();
    let input = |paste_mode, dirty, cli_foreground| Some(InputState { paste_mode, dirty, cli_foreground });
    assert_eq!(term.blocker(ready()), Some(Blocker::Unbound));
    term.apply_fire(fire("startup", "s", Path::new("/nope/s.jsonl")));
    assert_eq!(term.blocker(None), Some(Blocker::Unbound), "no PTY");
    assert_eq!(term.blocker(input(true, false, false)), Some(Blocker::Unbound), "the shell is back in front");
    assert_eq!(term.blocker(input(false, false, true)), Some(Blocker::NoPasteMode));
    assert_eq!(term.blocker(input(true, true, true)), Some(Blocker::DirtyInput));
    term.dialog = true;
    assert_eq!(term.blocker(input(true, true, true)), Some(Blocker::NativeDialog));
    term.dialog = false;
    assert_eq!(term.blocker(ready()), None);
    term.hook(&json!({"hook_event_name": "SessionEnd", "session_id": "s", "reason": "clear"}));
    assert_eq!(term.blocker(ready()), None, "a clear's SessionEnd is followed by its SessionStart");
    term.hook(&json!({"hook_event_name": "SessionEnd", "session_id": "s", "reason": "prompt_input_exit"}));
    assert_eq!(term.blocker(ready()), Some(Blocker::Unbound), "/exit");
    term.hook(&json!({"hook_event_name": "Notification", "notification_type": "permission_prompt", "session_id": "s"}));
    assert!(term.dialog, "a dialog the hooks never saw");
}

fn permission(id: &str, tool: &str, summary: &str) -> ConvoAsk {
    ConvoAsk {
        ask_id: id.into(),
        kind: "permission".into(),
        tool_name: tool.into(),
        summary: summary.into(),
        input: None,
        suggestions: None,
        rule: None,
        questions: None,
        opened_at: 0,
    }
}

#[test]
fn a_card_arms_only_for_a_watched_bound_session() {
    let mut term = Term::default();
    assert!(term.open_ask("s", permission("a0", "Bash", "ls"), None, json!({})).is_none(), "unbound: the hook answers {{}}");
    term.apply_fire(fire("startup", "s", Path::new("/nope/s.jsonl")));
    assert!(term.open_ask("s", permission("a1", "Bash", "ls"), None, json!({})).is_none(), "nobody watching");
    assert!(term.dialog, "so the TUI asks, and the composer waits");
    let (channel, batches) = recorder();
    term.subscribe(channel, ready());
    assert!(term.open_ask("other", permission("a2", "Bash", "ls"), None, json!({})).is_none(), "another session's ask");
    let mut rx = term.open_ask("s", permission("a3", "Bash", "ls"), None, json!({})).unwrap();
    assert_eq!(term.blocker(ready()), Some(Blocker::NativeDialog));
    // A snapshot taken now shows the open card.
    let snapshot = term.snapshot(ready());
    assert!(snapshot.0.iter().any(|e| e.id == "ask:a3" && matches!(e.body, Body::AskOpened { .. })));
    term.answer("a3", |_| Ok((json!({"decision": "allow"}), "allow"))).unwrap().unwrap();
    assert_eq!(rx.try_recv().unwrap(), json!({"decision": "allow"}));
    flush_all(&mut term);
    let got = delivered(&batches);
    assert!(got.ends_with(&["ask_opened".to_string(), "ask_closed".to_string()]), "{got:?}");
    let closed = lock(&batches).last().unwrap()["events"].as_array().unwrap().last().cloned().unwrap();
    assert_eq!((closed["askId"].as_str(), closed["outcome"].as_str()), (Some("a3"), Some("allow")));
    assert_eq!(term.answer("a3", |_| Ok((json!({}), "allow"))), None, "answered once");
}

#[test]
fn the_drop_guard_and_the_tui_close_cards_too() {
    let dir = scratch("asks");
    let path = dir.join("s.jsonl");
    std::fs::write(&path, "").unwrap();
    let mut term = Term::default();
    term.apply_fire(fire("startup", "s", &path));
    let (channel, batches) = recorder();
    term.subscribe(channel, ready());
    // The hook's connection dropped (Esc in the TUI, its timeout): expired.
    let _rx = term.open_ask("s", permission("gone", "Bash", "ls"), None, json!({})).unwrap();
    term.dialog = false;
    assert!(term.drop_ask("gone"));
    assert!(!term.drop_ask("gone"), "once");
    assert!(term.dialog, "a timed-out hook leaves the TUI's dialog up");
    // Answered in the TUI: its tool_use row (written after the hook, S3)
    // names the call, and its result closes the card.
    let mut rx = term.open_ask("s", permission("tui", "Bash", "touch a.txt"), None, json!({})).unwrap();
    let tool_use = json!({"type": "assistant", "uuid": "u1", "message": {"content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "touch a.txt"}}]}});
    let result = json!({"type": "user", "uuid": "u2", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": ""}]}});
    std::fs::write(&path, format!("{tool_use}\n")).unwrap();
    term.read();
    assert_eq!(term.asks[0].tool_use_id.as_deref(), Some("toolu_1"));
    std::fs::write(&path, format!("{tool_use}\n{result}\n")).unwrap();
    term.read();
    assert!(term.asks.is_empty());
    assert_eq!(rx.try_recv().unwrap(), json!({}), "the hook is let go");
    flush_all(&mut term);
    let outcomes: Vec<_> = lock(&batches)
        .iter()
        .flat_map(|b| b["events"].as_array().unwrap().clone())
        .filter(|e| e["kind"] == "ask_closed")
        .map(|e| e["outcome"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(outcomes, ["expired", "terminal"]);
    // A card that opens after its tool_use row finds it in the ring.
    std::fs::write(&path, format!("{tool_use}\n{result}\n{}\n", json!({"type": "assistant", "uuid": "u3", "message": {"content": [{"type": "tool_use", "id": "toolu_2", "name": "Bash", "input": {"command": "ls"}}]}}))).unwrap();
    term.read();
    let _rx = term.open_ask("s", permission("late", "Bash", "ls"), None, json!({})).unwrap();
    assert_eq!(term.asks[0].tool_use_id.as_deref(), Some("toolu_2"));
    // An interrupt ends every open card.
    std::fs::write(&path, format!("{tool_use}\n{result}\n{}\n{}\n", json!({"type": "assistant", "uuid": "u3", "message": {"content": [{"type": "tool_use", "id": "toolu_2", "name": "Bash", "input": {"command": "ls"}}]}}), json!({"type": "user", "uuid": "u4", "message": {"content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}}))).unwrap();
    term.read();
    assert!(term.asks.is_empty() && !term.dialog);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_composer_send_is_delivered_or_reported_undelivered() {
    let dir = scratch("expect");
    let path = dir.join("s.jsonl");
    std::fs::write(&path, "").unwrap();
    let mut term = Term::default();
    term.apply_fire(fire("startup", "s", &path));
    let (channel, batches) = recorder();
    term.subscribe(channel, ready());
    let now = Instant::now();
    let expect = |nonce: &str, text: &str| Expect { nonce: nonce.into(), key: match_key(text), at: now, queued: false };
    // By the prompt hook, 130 ms before the transcript line (S3).
    term.expects.push(expect("n1", "fix\tthe   bug"));
    term.hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "fix the bug", "prompt_id": "p1"}));
    assert!(term.working);
    // A type-ahead the CLI queued while busy: pending past 45 s, then
    // delivered when its UserPromptSubmit fires at its turn.
    term.expects.push(expect("n2", "and then this"));
    std::fs::write(&path, format!("{}\n", json!({"type": "queue-operation", "operation": "enqueue", "content": "and then this", "sessionId": "s"}))).unwrap();
    term.read();
    assert!(term.expects[0].queued);
    // Nothing for 45 s.
    term.expects.push(expect("n3", "lost"));
    let (due, _, _) = term.tick(now + Duration::from_secs(30));
    assert!(due <= now + EXPECT_WINDOW + Duration::from_millis(1));
    term.tick(now + Duration::from_secs(46));
    assert_eq!(term.expects.iter().map(|e| e.nonce.as_str()).collect::<Vec<_>>(), ["n2"], "the queued one waits");
    term.hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "and then this", "prompt_id": "p2"}));
    flush_all(&mut term);
    let events: Vec<Value> = lock(&batches).iter().flat_map(|b| b["events"].as_array().unwrap().clone()).collect();
    let outcome = |nonce: &str| events.iter().find(|e| e["nonce"] == nonce).map(|e| (e["kind"].as_str().unwrap().to_string(), e["promptId"].clone()));
    assert_eq!(outcome("n1"), Some(("delivered".into(), json!("p1"))));
    assert_eq!(outcome("n2"), Some(("delivered".into(), json!("p2"))));
    assert_eq!(outcome("n3").map(|o| o.0), Some("undelivered".into()));
    assert!(term.expects.is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

/// The two real ways a type-ahead ends (S9 and the queue follow-up): after
/// the turn (`dequeue`, then its own prompt line) or folded into the running
/// turn (`remove`, `absorbed_mid_turn`, no prompt line). Either way it is
/// pending, never undelivered, however long the turn runs.
#[test]
fn a_queued_send_waits_for_its_turn_however_long() {
    for (fixture, text, prompt_id) in [
        ("queue_operation", "Then reply with the single word queued.", true),
        ("queue_absorbed", "Also reply with the word absorbed.", false),
    ] {
        let dir = scratch("queued");
        let path = dir.join("s.jsonl");
        let lines: Vec<String> = std::fs::read_to_string(Path::new(FIXTURES).join(format!("{fixture}.jsonl"))).unwrap().lines().map(str::to_string).collect();
        let enqueue = lines.iter().position(|l| l.contains("\"operation\":\"enqueue\"")).unwrap();
        std::fs::write(&path, "").unwrap();
        let mut term = Term::default();
        term.apply_fire(fire("startup", "s", &path));
        let (channel, batches) = recorder();
        term.subscribe(channel, ready());
        let now = Instant::now();
        term.expects.push(Expect { nonce: "q".into(), key: match_key(text), at: now, queued: false });
        std::fs::write(&path, format!("{}\n", lines[..=enqueue].join("\n"))).unwrap();
        term.read();
        term.tick(now + Duration::from_secs(600));
        assert_eq!(term.expects.len(), 1, "{fixture}: still pending after ten minutes");
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        term.read();
        flush_all(&mut term);
        let events: Vec<Value> = lock(&batches).iter().flat_map(|b| b["events"].as_array().unwrap().clone()).collect();
        let delivered: Vec<_> = events.iter().filter(|e| e["nonce"] == "q").collect();
        assert_eq!(delivered.len(), 1, "{fixture}: {delivered:?}");
        assert_eq!(delivered[0]["kind"], "delivered");
        assert_eq!(delivered[0]["promptId"].is_string(), prompt_id, "{fixture}: a prompt line carries its id; an absorbed send has none");
        std::fs::remove_dir_all(dir).unwrap();
    }
    // Handed back to the input box (or removed unabsorbed): never sent.
    let mut term = Term::default();
    let now = Instant::now();
    for (nonce, queued) in [("a", true), ("b", true), ("c", false)] {
        term.expects.push(Expect { nonce: nonce.into(), key: match_key(nonce), at: now, queued });
    }
    let recalled = term.recall(|e| e.queued);
    assert_eq!(recalled.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["undelivered:a", "undelivered:b"]);
    assert_eq!(term.expects.len(), 1);
}

#[test]
fn batches_are_coalesced_to_one_per_fifty_ms() {
    let mut term = Term::default();
    let (channel, batches) = recorder();
    term.subscribe(channel, ready());
    let t0 = Instant::now();
    let event = |term: &Term| term.host(host_id(), Body::Thinking);
    let e = event(&term);
    term.emit(vec![e]);
    term.flush(t0);
    let e = event(&term);
    term.emit(vec![e]);
    let due = term.flush(t0 + Duration::from_millis(10));
    assert_eq!(lock(&batches).len(), 1, "held back");
    assert_eq!(due, t0 + BATCH_GAP);
    let e = event(&term);
    term.emit(vec![e]);
    term.flush(t0 + BATCH_GAP);
    assert_eq!(lock(&batches).len(), 2);
    assert_eq!(lock(&batches)[1]["events"].as_array().unwrap().len(), 2, "both waited for one batch");
}

#[test]
fn a_snapshot_is_the_recent_tail_headed_by_its_binding() {
    let mut term = Term::default();
    term.apply_fire(fire("startup", "s", Path::new("/nope/s.jsonl")));
    for i in 0..250u64 {
        term.ring.push(ConvoEvent { id: format!("e{i}"), epoch: 0, offset: 100 + i, ts: 0, body: Body::Thinking });
    }
    term.ring.complete = true;
    let (events, has_older) = term.snapshot(ready());
    assert!(has_older);
    assert_eq!(events.first().map(|e| kinds(std::slice::from_ref(e))[0].clone()).as_deref(), Some("bound"), "the binding, though older than the tail");
    assert_eq!(events.len(), 1 + SNAPSHOT_EVENTS + 1, "bound + 200 + readiness");
    assert_eq!(events[1].id, "e50");
    assert_eq!(events.last().unwrap().body, Body::Readiness { ready: true, blocker: None });
}

#[test]
fn the_turn_end_hook_reports_the_effort_and_mid_turn_switches_wait() {
    let mut term = Term::default();
    term.apply_fire(fire("startup", "s", Path::new("/nope/s.jsonl")));
    let (channel, batches) = recorder();
    term.subscribe(channel, ready());
    term.model = Some("claude-haiku-5-5".into());
    term.hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "go"}));
    assert!(term.switch_blocker(ready()).is_some_and(|r| r.contains("working")));
    term.hook(&json!({"hook_event_name": "Stop", "session_id": "s", "effort": {"level": "medium"}}));
    term.hook(&json!({"hook_event_name": "Stop", "session_id": "s", "effort": {"level": "medium"}}));
    assert_eq!(term.switch_blocker(ready()), None);
    flush_all(&mut term);
    let seen: Vec<Value> = lock(&batches).iter().flat_map(|b| b["events"].as_array().unwrap().clone()).filter(|e| e["kind"] == "model_seen").collect();
    assert_eq!(seen.len(), 1, "only a change is news");
    assert_eq!((seen[0]["model"].as_str(), seen[0]["effort"].as_str()), (Some("claude-haiku-5-5"), Some("medium")));
    // A nested session's hooks never reach here (`observe_hook` drops
    // `sdk-cli`), and another session's prompt doesn't count as this one's.
    term.hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "nested", "prompt": "go"}));
    assert!(!term.working);
}

/// W2's work drawer: a send while the agent is in a turn is held in the
/// outbox, not typed into the CLI's own type-ahead; it goes when the turn
/// ends, one at a time; Steer sends it now (Claude) or heads the queue and
/// asks for the interrupt (Codex); Edit and Remove take it back out.
#[test]
fn a_send_mid_turn_waits_in_the_outbox_for_the_turn_to_end() {
    let mut term = Term::default();
    term.apply_fire(fire("startup", "s", Path::new("/nope/s.jsonl")));
    let (channel, batches) = recorder();
    term.subscribe(channel, ready());
    let now = Instant::now();
    assert!(!term.enqueue("idle".into(), "hello".into()), "nothing running: the composer sends it itself");
    assert!(term.outbox.is_empty());

    term.hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "go"}));
    assert!(term.enqueue("n1".into(), "first".into()));
    assert!(term.enqueue("n2".into(), "second".into()));
    assert!(term.enqueue("n1".into(), "first".into()), "the same send twice is one row");
    assert_eq!(term.outbox.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["n1", "n2"]);
    assert_eq!(term.take_due(ready(), now), None, "mid-turn: held");
    let snapshot = term.snapshot(ready()).0;
    assert!(snapshot.iter().any(|e| matches!(&e.body, Body::Outbox { items } if items.len() == 2)), "a late subscriber sees the drawer");

    term.hook(&json!({"hook_event_name": "Stop", "session_id": "s"}));
    assert_eq!(term.take_due(None, now), None, "a CLI that can't take input keeps it");
    let first = term.take_due(ready(), now).expect("the turn ended: the head goes");
    assert_eq!(first.id, "n1");
    assert_eq!(term.take_due(ready(), now), None, "the next waits for this one to reach the prompt");
    assert!(term.enqueue("n3".into(), "third".into()), "a send in flight holds new ones too");
    term.hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "first", "prompt_id": "p1"}));
    assert!(term.expects.is_empty(), "delivered");
    term.hook(&json!({"hook_event_name": "Stop", "session_id": "s"}));
    assert_eq!(term.take_due(ready(), now).map(|i| i.id), Some("n2".into()));

    // Edit / Remove.
    assert_eq!(term.unqueue("n3"), Some("third".into()));
    assert_eq!(term.unqueue("n3"), None);
    flush_all(&mut term);
    let events: Vec<Value> = lock(&batches).iter().flat_map(|b| b["events"].as_array().unwrap().clone()).collect();
    let sent: Vec<_> = events.iter().filter(|e| e["kind"] == "sending").map(|e| e["nonce"].as_str().unwrap().to_string()).collect();
    assert_eq!(sent, ["n1", "n2"]);
    assert!(events.iter().any(|e| e["kind"] == "delivered" && e["nonce"] == "n1"));
    assert_eq!(events.iter().rev().find(|e| e["kind"] == "outbox").unwrap()["items"], json!([]));
    assert!(term.ring.iter().all(|e| !matches!(e.body, Body::Outbox { .. } | Body::Sending { .. })), "host-only, never replayed");

    // A refused hand-off says so.
    term.handoff_failed("n2");
    assert!(term.expects.is_empty());
}

#[test]
fn steer_types_it_now_or_heads_the_queue() {
    let mut term = Term::default();
    term.apply_fire(fire("startup", "s", Path::new("/nope/s.jsonl")));
    let now = Instant::now();
    term.hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "go"}));
    for (id, text) in [("a", "one"), ("b", "two"), ("c", "three")] {
        term.enqueue(id.into(), text.into());
    }
    // Claude, mid-turn: typed now, ahead of the rest, as a composer send.
    let (result, item) = term.steer("b", ready(), now);
    assert_eq!(result, SteerResult::Sent);
    assert_eq!(item.map(|i| i.text), Some("two".into()));
    assert_eq!(term.expects.iter().map(|e| e.nonce.as_str()).collect::<Vec<_>>(), ["b"]);
    assert_eq!(term.outbox.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["a", "c"]);
    // The CLI can't take input: it moves to the head, never to the tail.
    let dialog = Some(InputState { paste_mode: true, dirty: true, cli_foreground: true });
    assert_eq!(term.steer("c", dialog, now), (SteerResult::Blocked { blocker: Blocker::DirtyInput }, None));
    assert_eq!(term.outbox.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["c", "a"]);
    assert_eq!(term.steer("gone", ready(), now), (SteerResult::Gone, None));

    // Codex has no mid-turn path: the head of the queue, and an interrupt.
    let mut codex = Term::default();
    codex.apply_fire(bind::Fire { source: "startup".into(), session_id: "t".into(), transcript: PathBuf::new(), starts: true, harness: bind::Harness::Codex });
    codex.working = true;
    codex.enqueue("x".into(), "first".into());
    codex.enqueue("y".into(), "steered".into());
    assert_eq!(codex.steer("y", ready(), now), (SteerResult::Interrupt, None));
    assert_eq!(codex.outbox.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["y", "x"]);
    codex.working = false;
    assert_eq!(codex.take_due(ready(), now).map(|i| i.id), Some("y".into()), "the interrupted turn's end delivers it");
}
