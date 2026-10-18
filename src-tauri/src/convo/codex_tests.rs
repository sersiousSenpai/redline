// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Codex mirror's tests: golden fixtures cut from real app-server
//! streams, the mapping's rules, and a Codex terminal's binding and cards.
//!
//! Each `tests/fixtures/convo/codex_<name>.jsonl` holds the messages a second
//! client received from codex-cli 0.162.1 in experiment (m), S10
//! (`scripts/verify-codex-mirror.py --fixtures`): one phase's notifications
//! and requests (headed by the read the mirror makes when it joins, where it
//! joined mid-turn), or one cold read (`thread/items/list`'s answer). Temp
//! paths, user and host names are scrubbed. `<name>.events.json` is what the mapper
//! makes of it; the frontend reducer's tests read the same pairs.
//! `CONVO_BLESS=1 cargo test --lib convo::` rewrites them.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::codex::{self, AskReply, CodexPolled, Mapper};
use super::*;

const FIXTURES: &str = "tests/fixtures/convo";

fn codex_fixtures() -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::fs::read_dir(FIXTURES)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl") && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("codex_")))
        .collect();
    paths.sort();
    assert!(paths.len() >= 6, "the Codex fixture set is missing: {paths:?}");
    paths
}

fn lines(name: &str) -> Vec<Value> {
    std::fs::read_to_string(Path::new(FIXTURES).join(format!("codex_{name}.jsonl")))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// The fixture's thread: the one its messages name, or, for a cold read,
/// the one its cursor was asked for.
fn thread_of(lines: &[Value]) -> String {
    lines
        .iter()
        .find_map(|l| l.pointer("/params/threadId").and_then(Value::as_str).map(str::to_string))
        .or_else(|| {
            let cursor = lines.iter().find_map(|l| l.pointer("/result/backwardsCursor").and_then(Value::as_str))?;
            serde_json::from_str::<Value>(cursor).ok()?.get("requestedThreadId").and_then(Value::as_str).map(str::to_string)
        })
        .expect("a thread")
}

fn events(name: &str) -> Vec<ConvoEvent> {
    let lines = lines(name);
    codex::replay(&lines, &thread_of(&lines))
}

fn kinds(events: &[ConvoEvent]) -> Vec<String> {
    events.iter().map(|e| serde_json::to_value(e).unwrap()["kind"].as_str().unwrap().to_string()).collect()
}

#[test]
fn codex_golden_fixtures_match_their_events() {
    let bless = std::env::var_os("CONVO_BLESS").is_some();
    for path in codex_fixtures() {
        let lines: Vec<Value> = std::fs::read_to_string(&path).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let events = serde_json::to_value(codex::replay(&lines, &thread_of(&lines))).unwrap();
        let golden = path.with_extension("events.json");
        if bless {
            std::fs::write(&golden, format!("{}\n", serde_json::to_string_pretty(&events).unwrap())).unwrap();
            continue;
        }
        let want: Value = serde_json::from_str(&std::fs::read_to_string(&golden).unwrap_or_else(|_| panic!("{golden:?} missing; bless it"))).unwrap();
        assert_eq!(events, want, "{path:?} no longer reads as its golden events");
    }
}

/// Every fixture: ids unique, offsets inside a JavaScript number, and the
/// two events of a tool item side by side.
#[test]
fn codex_events_are_unique_ordered_and_safe_for_the_stage() {
    for path in codex_fixtures() {
        let name = path.file_stem().unwrap().to_string_lossy().trim_start_matches("codex_").to_string();
        let events = events(&name);
        assert!(!events.is_empty(), "{name}");
        let ids: HashSet<_> = events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids.len(), events.len(), "{name}: ids are unique");
        assert!(events.iter().all(|e| e.offset < (1u64 << 53)), "{name}: offsets fit a JS number");
        for e in &events {
            if let Body::ToolResult { tool_use_id, .. } = &e.body {
                let used = events.iter().find(|u| matches!(&u.body, Body::ToolUse { tool_use_id: t, .. } if t == tool_use_id));
                assert_eq!(used.map(|u| u.offset), Some(e.offset), "{name}: a result sits with its call");
            }
        }
    }
}

/// The live stream and a cold read of the same thread place every item at
/// the same offset under the same id: a page is the forward read.
#[test]
fn a_cold_read_places_items_where_the_live_tail_did() {
    let live = events("review_loop");
    let read = events("review_read");
    let mut shared = 0;
    for e in &live {
        if let Some(twin) = read.iter().find(|r| r.id == e.id) {
            assert_eq!((twin.offset, kinds(std::slice::from_ref(twin))), (e.offset, kinds(std::slice::from_ref(e))), "{}", e.id);
            shared += 1;
        }
    }
    assert!(shared >= 8, "the two overlap: {shared}");
}

#[test]
fn a_review_loop_reads_as_proposals_feedback_and_approval() {
    let events = events("review_loop");
    let tools: Vec<(String, String)> = events
        .iter()
        .filter_map(|e| match &e.body {
            Body::ToolUse { name, summary, .. } => Some((name.clone(), summary.clone())),
            _ => None,
        })
        .collect();
    assert!(tools.iter().any(|(n, s)| n == "Read" && s.ends_with("README.md")), "{tools:?}");
    assert!(tools.contains(&("Grep".to_string(), "probe".to_string())), "{tools:?}");
    assert!(tools.iter().any(|(n, _)| n == "LS"), "{tools:?}");
    let plans: Vec<(String, Option<String>)> = events
        .iter()
        .filter_map(|e| match &e.body {
            Body::PlanProposed { tool_use_id, title, session_id } => {
                assert_eq!(session_id, &thread_of(&lines("review_loop")), "the id plan-received carries");
                Some((tool_use_id.clone(), title.clone()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(plans.iter().map(|p| p.1.as_deref()).collect::<Vec<_>>(), [Some("Greeting v1"), Some("Greeting v2")]);
    let outcomes: Vec<(String, String, Option<String>)> = events
        .iter()
        .filter_map(|e| match &e.body {
            Body::PlanOutcome { tool_use_id, outcome, feedback } => Some((tool_use_id.clone(), outcome.clone(), feedback.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(outcomes[0], (plans[0].0.clone(), "feedback".into(), Some("Add a step that verifies the file.".into())), "the review's marks answer v1");
    assert_eq!(outcomes[1], (plans[1].0.clone(), "approved".into(), None), "Approve answers v2");
    assert!(
        !events.iter().any(|e| matches!(&e.body, Body::UserText { text, .. } if text.starts_with("Redline plan approved"))),
        "the hand-off is Redline's words, not a bubble"
    );
    assert!(events.iter().any(|e| matches!(&e.body, Body::AssistantText { text, .. } if text == "Revised as asked.")), "prose around a plan stays");
    assert_eq!(kinds(&events).iter().filter(|k| *k == "turn_end").count(), 2);
}

#[test]
fn a_plan_turn_reads_as_thinking_a_step_prose_and_the_plan() {
    let events = events("plan_turn");
    let k = kinds(&events);
    assert_eq!(k[..2], ["user_text", "thinking"], "the prompt from the read made on joining, then the turn live");
    let proposed = k.iter().position(|k| k == "plan_proposed").unwrap();
    assert_eq!(k[proposed - 1], "assistant_text");
    assert_eq!(k.last().map(String::as_str), Some("turn_end"));
    let Body::PlanProposed { title, .. } = &events[proposed].body else { unreachable!() };
    assert_eq!(title.as_deref(), Some("Add a greeting file"));
}

#[test]
fn approvals_become_cards_that_send_back_codex_decisions() {
    let lines = lines("build_approvals");
    let asks = codex::asks_of(&lines, &thread_of(&lines));
    assert_eq!(asks.len(), 2, "two approvals");
    let (ask, reply) = &asks[0];
    assert_eq!((ask.kind.as_str(), ask.tool_name.as_str(), ask.summary.as_str()), ("permission", "Bash", "touch from-client.txt"));
    assert!(ask.rule.as_deref().is_some_and(|r| r.contains("`touch from-client.txt`")), "{:?}", ask.rule);
    assert!(reply.request_id.is_number(), "the JSON-RPC id it came with");
    let decision = |answer: AskAnswer| codex::reply(ask, &answer).map(|(v, outcome)| (v, outcome));
    assert_eq!(decision(AskAnswer::Allow).unwrap(), (json!({"decision": "accept"}), "allow"));
    let (always, _) = decision(AskAnswer::Always).unwrap();
    assert_eq!(always["decision"]["acceptWithExecpolicyAmendment"]["execpolicy_amendment"], json!(["touch", "from-client.txt"]));
    assert_eq!(decision(AskAnswer::Deny { message: None }).unwrap(), (json!({"decision": "cancel"}), "deny"));
    assert_eq!(decision(AskAnswer::Terminal).unwrap(), (Value::Null, "terminal"));
    assert!(decision(AskAnswer::Answers { answers: Default::default() }).is_err());
    // Both were resolved: one from this side, one in the TUI.
    let resolved = lines.iter().filter(|l| l.get("method").and_then(Value::as_str) == Some("serverRequest/resolved")).count();
    assert_eq!(resolved, 2);
    let events = codex::replay(&lines, &thread_of(&lines));
    assert!(events.iter().any(|e| matches!(&e.body, Body::ToolUse { name, summary, .. } if name == "Write" && summary.ends_with("hello.txt"))));
}

#[test]
fn an_interrupted_turn_ends_interrupted_and_its_command_sorts_where_it_started() {
    let interrupted = events("interrupt");
    assert_eq!(kinds(&interrupted).last().map(String::as_str), Some("interrupted"));
    assert!(interrupted.last().unwrap().id.ends_with(":end"));
    // Read back after a restore, the cut-off command completes late (failed),
    // yet sorts inside its own turn, before the next prompt.
    let read = events("restored_read");
    let failed = read.iter().find(|e| matches!(&e.body, Body::ToolResult { is_error: true, .. })).expect("the failed sleep");
    let next_prompt = read.iter().find(|e| matches!(&e.body, Body::UserText { text, .. } if text == "Are you still there?")).expect("the next prompt");
    assert!(failed.offset < next_prompt.offset);
}

// --- the mapping, one message at a time -------------------------------------------

fn note(method: &str, params: Value) -> Value {
    json!({"method": method, "params": params})
}

fn item(stage: &str, turn: &str, at: i64, item: Value) -> Value {
    let key = if stage == "item/started" { "startedAtMs" } else { "completedAtMs" };
    note(stage, json!({"threadId": "t", "turnId": turn, key: at, "item": item}))
}

fn feed(map: &mut Mapper, messages: &[Value]) -> CodexPolled {
    let mut out = CodexPolled::default();
    for m in messages {
        map.message(m, 7, &mut out);
    }
    out
}

const TURN: &str = "01a14e6b-13cf-7611-938e-9e7fa04a233b";

#[test]
fn offsets_are_places_within_the_turn_and_its_end_comes_after() {
    let mut map = Mapper::new("t", 0);
    let base = 0x01a14e6b13cf * codex::SLOTS;
    let read = feed(&mut map, &[
        item("item/started", TURN, 1000, json!({"type": "agentMessage", "id": "m1", "text": ""})),
        item("item/started", TURN, 900, json!({"type": "commandExecution", "id": "c1", "command": "/bin/zsh -lc 'npm test'", "commandActions": []})),
        item("item/completed", TURN, 1500, json!({"type": "agentMessage", "id": "m1", "text": "Running the tests."})),
        item("item/completed", TURN, 1600, json!({"type": "commandExecution", "id": "c1", "command": "/bin/zsh -lc 'npm test'", "commandActions": [], "status": "completed", "exitCode": 1, "aggregatedOutput": "1 failed"})),
        note("turn/completed", json!({"threadId": "t", "turn": {"id": TURN, "status": "completed", "durationMs": 900}})),
        note("item/completed", json!({"threadId": "other", "turnId": "x", "completedAtMs": 2000, "item": {"type": "agentMessage", "id": "o", "text": "not ours"}})),
    ]);
    let got: Vec<(String, u64)> = read.polled.events.iter().map(|e| (e.id.clone(), e.offset)).collect();
    let want = [("c1:0", base + 2), ("m1", base), ("c1:1", base + 2), (&format!("{TURN}:end")[..], base + 3)];
    assert_eq!(got, want.map(|(id, offset)| (id.to_string(), offset)), "first sight, not the clock");
    assert!(matches!(&read.polled.events[0].body, Body::ToolUse { name, summary, .. } if name == "exec_command" && summary == "npm test"));
    assert!(matches!(&read.polled.events[2].body, Body::ToolResult { is_error: true, preview, .. } if preview == "1 failed"));
    assert_eq!(read.working, Some(false));
    assert_eq!(map.offset(), base + 4, "a host event lands after the end");
    // The next turn's range starts at its own id's millisecond.
    let next = "01a14e6b-2c81-7850-a98b-24ae161d65c0";
    let later = feed(&mut map, &[item("item/completed", next, 5, json!({"type": "reasoning", "id": "r"}))]);
    assert_eq!(later.polled.events[0].offset, 0x01a14e6b2c81 * codex::SLOTS);
}

#[test]
fn what_a_codex_thread_never_shows() {
    let mut map = Mapper::new("t", 0);
    let read = feed(&mut map, &[
        // A Stop hook's block reason with no proposal before it: the user's own hook.
        item("item/completed", TURN, 1, json!({"type": "hookPrompt", "id": "h", "fragments": [{"text": "keep going"}]})),
        // Redline's hand-off with no proposal in view: nothing to attach it to.
        item("item/completed", TURN, 2, json!({"type": "userMessage", "id": "u", "content": [{"type": "text", "text": codex_handoff()}]})),
        item("item/completed", TURN, 3, json!({"type": "agentMessage", "id": "e", "text": "  "})),
        item("item/completed", TURN, 4, json!({"type": "reasoning", "id": "r", "summary": ["secret"], "content": ["secret"]})),
        item("item/completed", TURN, 5, json!({"type": "enteredReviewMode", "id": "x", "review": "r"})),
    ]);
    assert_eq!(kinds(&read.polled.events), ["thinking"]);
    assert!(!serde_json::to_string(&read.polled.events).unwrap().contains("secret"), "thinking is marked, never mirrored");
}

fn codex_handoff() -> String {
    crate::codex_app_server::implementation_prompt("# A plan")
}

#[test]
fn a_failed_turn_says_why_and_a_reread_repeats_nothing() {
    let mut map = Mapper::new("t", 0);
    let started = item("item/started", TURN, 10, json!({"type": "userMessage", "id": "u", "content": [{"type": "text", "text": "go"}]}));
    let done = item("item/completed", TURN, 10, json!({"type": "userMessage", "id": "u", "content": [{"type": "text", "text": "go"}]}));
    let failed = note("turn/completed", json!({"threadId": "t", "turn": {"id": TURN, "status": "failed", "error": {"message": "Rate limited."}}}));
    let read = feed(&mut map, &[started, done.clone(), failed.clone(), done, failed]);
    assert_eq!(kinds(&read.polled.events), ["user_text", "assistant_text", "turn_end"]);
    assert!(matches!(&read.polled.events[1].body, Body::AssistantText { text, .. } if text == "Rate limited."));
    // A cold read of the same item after a reconnect: already given.
    let entry = json!({"turnId": TURN, "startedAtMs": 10, "item": {"type": "userMessage", "id": "u", "content": [{"type": "text", "text": "go"}]}});
    assert!(map.listed(&[entry], 0).is_empty());
}

#[test]
fn settings_report_the_model_once_per_change() {
    let mut map = Mapper::new("t", 0);
    let settings = |model: &str, effort: &str| note("thread/settings/updated", json!({"threadId": "t", "threadSettings": {"model": model, "effort": effort}}));
    let read = feed(&mut map, &[settings("gpt-5.5", "high"), settings("gpt-5.5", "high"), settings("gpt-5.5", "low")]);
    let seen: Vec<_> = read.polled.events.iter().map(|e| e.body.clone()).collect();
    assert_eq!(seen, [
        Body::ModelSeen { model: "gpt-5.5".into(), effort: Some("high".into()) },
        Body::ModelSeen { model: "gpt-5.5".into(), effort: Some("low".into()) },
    ]);
}

#[test]
fn shell_wrappers_and_turn_ids_unwrap() {
    for (wrapped, inner) in [
        ("/bin/zsh -lc 'npm test'", "npm test"),
        ("/bin/bash -c 'echo '\\''hi'\\'''", "echo 'hi'"),
        ("bash -lc ls", "ls"),
        ("npm test -c 'x'", "npm test -c 'x'"),
        ("git commit -m 'a -c b'", "git commit -m 'a -c b'"),
    ] {
        assert_eq!(codex::unwrap_shell_for_test(wrapped), inner, "{wrapped}");
    }
    // A turn id that isn't a UUIDv7 starts its range at its first item's time.
    let mut map = Mapper::new("t", 0);
    let read = feed(&mut map, &[note("item/completed", json!({"threadId": "t", "turnId": "turn-1", "completedAtMs": 42, "item": {"type": "reasoning", "id": "r"}}))]);
    assert_eq!(read.polled.events[0].offset, 42 * codex::SLOTS);
}

/// The launcher's socket convention is the one discovery looks for.
#[test]
fn discovery_matches_the_launcher() {
    let launcher = include_str!("../codex_plan_launch.sh");
    assert!(launcher.contains(&format!("mktemp -d {}/{}XXXXXXXX", codex::SOCKET_ROOT, codex::SOCKET_DIR_PREFIX)), "the socket's directory");
    assert!(launcher.contains(&format!("$socket_dir/{}", codex::SOCKET_NAME)), "the socket's name");
}

/// Only a private directory this user made, holding a real socket, counts:
/// the daemon's routes take socket paths from any local process.
#[cfg(unix)]
#[test]
fn discovery_opens_only_private_sockets_of_this_user() {
    use std::os::unix::fs::PermissionsExt;
    // Short: a socket path must fit in 104 bytes.
    let root = PathBuf::from("/tmp").join(format!("rls{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::create_dir_all(&root).unwrap();
    let make = |name: &str, mode: u32, socket: bool| {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
        let path = dir.join(codex::SOCKET_NAME);
        if socket {
            std::mem::forget(std::os::unix::net::UnixListener::bind(&path).unwrap());
        } else {
            std::fs::write(&path, "").unwrap();
        }
        path
    };
    let good = make("rlcx.good0001", 0o700, true);
    make("rlcx.open0001", 0o755, true);
    make("rlcx.file0001", 0o700, false);
    make("other.0001", 0o700, true);
    std::os::unix::fs::symlink(root.join("rlcx.good0001"), root.join("rlcx.link0001")).unwrap();
    codex::SCAN_ROOT.with(|r| *r.borrow_mut() = root.clone());
    assert_eq!(codex::launcher_sockets_for_test(), [good]);
    // A socket that isn't an app-server answers nothing: not this thread's.
    assert!(codex::find("t", None).is_none());
    std::fs::remove_dir_all(root).unwrap();
}

// --- a Codex terminal ---------------------------------------------------------------

fn codex_bound(term: &mut Term, thread: &str, socket: &str) {
    term.apply_fire(bind::Fire {
        source: "prompt".into(),
        session_id: thread.into(),
        transcript: PathBuf::from(socket),
        starts: false,
        harness: bind::Harness::Codex,
    });
}

fn approval(item: &str, request: u64) -> (ConvoAsk, AskReply) {
    let ask = ConvoAsk {
        ask_id: item.into(),
        kind: "permission".into(),
        tool_name: "Bash".into(),
        summary: "npm test".into(),
        input: None,
        suggestions: Some(vec![json!("acceptForSession")]),
        rule: None,
        questions: None,
        opened_at: 0,
    };
    (ask, AskReply { request_id: json!(request) })
}

fn closed(term: &mut Term) -> Vec<(String, String)> {
    let mut events = Vec::new();
    for sub in &mut term.subs {
        events.extend(std::mem::take(&mut sub.pending));
    }
    events
        .into_iter()
        .filter_map(|e| match e.body {
            Body::AskClosed { ask_id, outcome } => Some((ask_id, outcome)),
            _ => None,
        })
        .collect()
}

fn subscribed(term: &mut Term) {
    let channel = Channel::new(|_| Ok(()));
    term.subscribe(channel, Some(InputState { paste_mode: true, dirty: false, cli_foreground: true }));
}

#[test]
fn a_codex_approval_is_a_card_the_tui_or_the_stage_answers() {
    let mut term = Term::default();
    codex_bound(&mut term, "t", "");
    subscribed(&mut term);
    term.codex_read(CodexPolled { asks: vec![approval("c1", 0), approval("c2", 1), approval("c3", 2)], waiting: Some(true), ..Default::default() });
    assert_eq!(term.asks.len(), 3);
    assert!(term.dialog, "the TUI's own prompt is up meanwhile");
    assert_eq!(term.asks[0].tool_use_id.as_deref(), Some("c1"), "its item's result closes it too");
    // Answered in the TUI: the server says so.
    term.codex_read(CodexPolled { resolved: vec![codex::request_key(&json!(0))], ..Default::default() });
    // Left to the terminal from the card: nothing is sent, the card closes.
    term.answer("c2", |p| asks_reply(p, AskAnswer::Terminal)).unwrap().unwrap();
    // An answer with no connection to send it on fails, and says so.
    assert!(term.answer("c3", |p| asks_reply(p, AskAnswer::Allow)).unwrap().is_err());
    assert_eq!(closed(&mut term), [("c1".into(), "terminal".into()), ("c2".into(), "terminal".into()), ("c3".into(), "expired".into())]);
    // The same request again (a re-read) opens nothing new.
    term.codex_read(CodexPolled { asks: vec![approval("c4", 3)], ..Default::default() });
    term.codex_read(CodexPolled { asks: vec![approval("c4", 3)], ..Default::default() });
    assert_eq!(term.asks.len(), 1);
    term.codex_read(CodexPolled { waiting: Some(false), ..Default::default() });
    assert!(!term.dialog);
}

fn asks_reply(pending: &PendingAsk, answer: AskAnswer) -> Result<(Value, &'static str), String> {
    crate::asks::reply(pending, &answer)
}

#[test]
fn a_codex_no_launcher_serves_is_shown_in_its_terminal() {
    codex::SCAN_ROOT.with(|r| *r.borrow_mut() = std::env::temp_dir().join(format!("rl-empty-{}", uuid::Uuid::new_v4())));
    let mut term = Term::default();
    subscribed(&mut term);
    let now = Instant::now();
    let candidate = |thread: &str| codex::Candidate { thread_id: thread.into(), socket: None, source: "prompt".into(), tries: 0, due: now };
    term.candidate = Some(candidate("t1"));
    let mut bound = None;
    for step in 0..codex::CANDIDATE_TRIES {
        let (_, _, b) = term.tick(now + codex::CANDIDATE_RETRY * u32::from(step) + Duration::from_millis(1));
        bound = bound.or(b);
    }
    let bound = bound.expect("bound after its looks");
    assert_eq!((bound.harness, bound.path), (bind::Harness::Codex, None), "no transcript to persist");
    let mark = term.marks.last().unwrap();
    assert!(matches!(&mark.body, Body::Bound { harness, mirrored: Some(false), .. } if harness == "codex"));
    assert!(term.switch_blocker(None).is_some_and(|r| r.contains("Codex terminal")), "no /model or /plan typed into Codex");

    // A terminal mirroring a thread keeps it when a nested `codex exec`'s
    // hook names another thread that nothing serves.
    let mut term = Term::default();
    codex_bound(&mut term, "t", "/tmp/rlcx.gone/server.sock");
    term.candidate = Some(candidate("nested"));
    for step in 0..codex::CANDIDATE_TRIES {
        term.tick(now + codex::CANDIDATE_RETRY * u32::from(step) + Duration::from_millis(1));
    }
    assert_eq!(term.binding.as_ref().map(|b| b.session_id.as_str()), Some("t"));
    assert!(term.candidate.is_none());
}

/// Driven by `scripts/verify-codex-mirror.py --rust` against an isolated real
/// CLI: the mirror joins its TUI's thread through `CodexSource`, sees the
/// turn the rig types, answers its approval from here, and reads the thread
/// back cold, every item where the live tail put it.
#[test]
#[ignore = "requires the isolated Codex mirror rig"]
fn codex_live_mirror_probe() {
    let var = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("{key} is the rig's"));
    let (socket, thread, ready) = (var("REDLINE_PROBE_SOCKET"), var("REDLINE_PROBE_THREAD"), var("REDLINE_PROBE_READY"));
    let mut source = codex::CodexSource::new(&thread, Some(socket.clone()), None, 0);
    let joined = Instant::now();
    let first = source.poll(0);
    let join_ms = joined.elapsed().as_millis();
    assert!(!first.polled.events.is_empty(), "the thread's history before the probe");
    std::fs::write(&ready, "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut live = Vec::new();
    let mut answered = Vec::new();
    while Instant::now() < deadline {
        let read = source.poll(0);
        for (ask, reply) in &read.asks {
            let (result, _) = codex::reply(ask, &AskAnswer::Allow).unwrap();
            source.respond(&reply.request_id, result).unwrap();
            answered.push(ask.summary.clone());
        }
        live.extend(read.polled.events);
        if live.iter().any(|e| matches!(&e.body, Body::TurnEnd { .. })) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let k = kinds(&live);
    assert!(live.iter().any(|e| matches!(&e.body, Body::UserText { text, .. } if text == "Mirror probe prompt.")), "{k:?}");
    assert!(live.iter().any(|e| matches!(&e.body, Body::ToolResult { is_error: false, .. })), "the approved command ran: {k:?}");
    assert!(live.iter().any(|e| matches!(&e.body, Body::AssistantText { text, .. } if text == "Mirror probe reply.")), "{k:?}");
    assert_eq!(answered, ["touch from-rust.txt"]);
    let mut cold = codex::CodexSource::new(&thread, Some(socket), None, 0);
    let read = cold.poll(0).polled.events;
    for e in live.iter().filter(|e| !e.id.contains(":end")) {
        let twin = read.iter().find(|r| r.id == e.id).unwrap_or_else(|| panic!("{} missing from the cold read", e.id));
        assert_eq!((twin.offset, &twin.body), (e.offset, &e.body), "{}", e.id);
    }
    println!("PROBE {}", json!({"join_ms": join_ms, "history": first.polled.events.len(), "live": k, "answered": answered}));
}
