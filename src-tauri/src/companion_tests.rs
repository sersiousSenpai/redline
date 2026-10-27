// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `companion.rs`'s `mod tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;

const SELF_ID: &str = "chat-self";

/// Either harness's turn carries the daemon token in its environment, so
/// the chat's bridge writes authenticate, and the companion seat.
#[test]
fn a_turn_spawns_with_the_daemon_token() {
    use std::ffi::OsStr;
    for codex in [true, false] {
        let cmd = cold_command("/nonexistent/harness", "/", &[], codex);
        let std = cmd.as_std();
        let env = |key: &str| std.get_envs().find(|(k, _)| *k == OsStr::new(key)).and_then(|(_, v)| v);
        assert_eq!(env(crate::auth::ENV_DAEMON_TOKEN), Some(OsStr::new(crate::auth::daemon_token())), "codex: {codex}");
        assert_eq!(env(crate::claude_proc::ENV_AGENT_SEAT), Some(OsStr::new("companion")), "codex: {codex}");
    }
    let codex = cold_command("/nonexistent/codex", "/", &[], true);
    assert_eq!(codex.as_std().get_args().collect::<Vec<_>>(), ["app-server"]);
}

fn surface(kind: &str, label: Option<&str>, detail: Option<&str>) -> SurfaceInfo {
    SurfaceInfo {
        kind: kind.to_string(),
        id: Some("x-1".to_string()),
        label: label.map(str::to_string),
        detail: detail.map(str::to_string),
        project_path: None,
        updated_at: 0,
    }
}

fn row(id: i64, kind: &str, label: Option<&str>, detail: Option<&str>) -> JournalRow {
    JournalRow {
        id,
        ts: id,
        kind: kind.to_string(),
        surface_kind: Some("browser".to_string()),
        surface_id: None,
        label: label.map(str::to_string),
        detail: detail.map(str::to_string),
    }
}

fn msg(id: &str, chat: &str, role: &str, body: &str, at: i64) -> CompanionMessage {
    CompanionMessage {
        id: id.to_string(),
        companion_id: chat.to_string(),
        role: role.to_string(),
        body: body.to_string(),
        status: "complete".to_string(),
        surface_kind: Some("chat".to_string()),
        surface_id: Some(chat.to_string()),
        surface_label: None,
        created_at: at,
    }
}

fn chat(id: &str) -> Companion {
    Companion {
        companion_id: id.to_string(),
        title: "Chat".to_string(),
        status: "active".to_string(),
        created_at: 1,
        updated_at: 1,
        model: None,
        effort: None,
        title_is_user_set: false,
        archived_at: None,
        project_path: None,
    }
}

#[test]
fn describe_surface_names_the_surface_tolerantly() {
    assert_eq!(
        describe_surface(&surface("plan", Some("My plan"), None)),
        "the plan review — My plan"
    );
    assert_eq!(
        describe_surface(&surface("browser", Some("Docs"), Some("https://x"))),
        "the embedded browser — Docs (https://x)"
    );
    assert_eq!(
        describe_surface(&surface("welcome", None, None)),
        "the welcome screen"
    );
    // The chat room is a surface of its own now — without this arm the
    // agent's own room reported as the welcome screen.
    assert_eq!(
        describe_surface(&surface("chat", Some("The anchoring thing"), None)),
        "a chat room — The anchoring thing"
    );
}

/// The self-reference guard: when the active surface IS the chat the agent
/// is in, say so and hand over NO write-target id.
#[test]
fn surface_line_refuses_to_hand_a_chat_its_own_thread() {
    let mut own = surface("chat", Some("The anchoring thing"), None);
    own.id = Some(SELF_ID.to_string());
    let line = surface_line(&own, SELF_ID);
    assert!(line.contains("this chat"));
    assert!(
        !line.contains("[surface id:"),
        "its own thread must never be offered as a write target: {line}"
    );
    // Another chat is a normal surface, id and all.
    let other = surface("chat", Some("Something else"), None);
    let line = surface_line(&other, SELF_ID);
    assert!(line.contains("a chat room — Something else"));
    assert!(line.contains("[surface id: x-1]"));
}

#[test]
fn journal_delta_groups_navs_and_bounds_bytes() {
    let rows = vec![
        row(1, "surface_switch", Some("My plan"), None),
        row(2, "nav", Some("Page A"), Some("https://a")),
        row(3, "nav", Some("Page B"), Some("https://b")),
        row(4, "nav", Some("Page C"), Some("https://c")),
        row(5, "revision", Some("My plan"), Some("v3")),
    ];
    let d = render_journal_delta(&rows, 4000);
    assert!(d.contains("WHILE YOU WERE AWAY"));
    assert!(d.contains("browsed 3 pages, ending at Page C"));
    assert!(!d.contains("Page A"), "grouped navs collapse to one line");
    assert!(d.contains("a plan revision arrived — My plan (v3)"));

    // Byte bound keeps the TAIL and says what was elided.
    let many: Vec<JournalRow> = (0..100)
        .map(|i| row(i, "surface_switch", Some(&format!("surface {i}")), None))
        .collect();
    let bounded = render_journal_delta(&many, 300);
    assert!(bounded.len() < 600);
    assert!(bounded.contains("surface 99"), "the newest event survives");
    assert!(bounded.contains("elided"));
    // Empty delta renders nothing at all.
    assert_eq!(render_journal_delta(&[], 4000), "");
}

/// The batched read must lead the memory routes: a chat's whole value is
/// "it already knows my record", and a tree walk spends a model turn
/// learning node ids the pack returns for free.
#[test]
fn routes_block_teaches_the_answer_pack_before_the_tree() {
    let b = routes_block();
    let pack = b
        .find("/v1/memory/answer-pack")
        .expect("answer-pack is taught");
    let tree = b.find("/v1/memory/tree").expect("the tree walk survives");
    assert!(pack < tree, "the answer-pack must be taught FIRST");
    assert!(b.contains("/v1/memory/grep?q="), "literals need grep");
    assert!(b.contains("Read the pack, then ANSWER"));
    // The voice agent embeds this block verbatim, and its own test pins the
    // rest of the contract — these are the routes that must not have been
    // displaced by the insertion.
    assert!(b.contains("/v1/memory/node/<id>"));
    assert!(b.contains("/v1/global/consult"));
}

#[test]
fn first_turn_embeds_role_surface_journal_and_consult_contract() {
    let s = surface("plan", Some("Companion plan"), None);
    let body = build_first_turn_prompt(
        &s,
        SELF_ID,
        "WHILE YOU WERE AWAY — what the user did since your last turn:\n- browsed to X\n",
        "what did I miss?",
        &FirstTurnGround {
            mission: Some(("Research", "Find the best DB")),
            ..Default::default()
        },
    );
    assert!(body.contains("the plan review — Companion plan"));
    // The surface id rides the per-turn line (the write routes key on it).
    assert!(body.contains("[surface id: x-1]"));
    assert!(body.contains("WHILE YOU WERE AWAY"));
    // Mission inheritance rides the shared block.
    assert!(body.contains("Find the best DB"));
    assert!(body.contains("what did I miss?"));
    // The contract is the SYSTEM PROMPT now (`--append-system-prompt`),
    // said once per CLI session, never in a turn body.
    assert!(!body.contains("/v1/global/consult"));
    assert!(!body.contains("CHAT ROOM"));
    let p = system_prompt();
    assert!(p.contains("CHAT ROOM"));
    assert!(p.contains("/v1/global/agents"));
    assert!(p.contains("/v1/global/consult"));
    assert!(p.contains("/v1/context/threads/"));
    assert!(p.contains("/v1/context/tree/"));
    assert!(p.contains("/v1/journal/recent"));
    // No skill round trip: the prompt says the skill is not needed.
    assert!(p.contains("do not need to load the `companion` skill"));

    // The write contract: user-directed only, staged/reviewable, all four
    // recipes present with the auth header, and the exclusions explicit.
    assert!(p.contains("WRITES — ONLY AT THE USER'S DIRECTION"));
    assert!(p.contains("curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/plan"));
    assert!(p.contains("curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/comments"));
    assert!(p.contains("\"agentId\":\"companion\""));
    assert!(p.contains("curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/doc"));
    assert!(p.contains("curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/suggestions"));
    assert!(
        p.contains("curl -s 'http://127.0.0.1:7676/v1/reviews/annotations?repo=<repo_path>'")
    );
    assert!(p.contains("\"source\":\"companion\""));
    assert!(p.contains("curl -s http://127.0.0.1:7676/v1/memory/proposals"));
    // The auth flags must survive verbatim as curl's own variable import:
    // shell expansion (`$REDLINE_DAEMON_TOKEN`) never reaches the daemon
    // because the agent bash sandbox rejects the command outright.
    assert!(p.contains(
        "--variable %REDLINE_DAEMON_TOKEN= \
             --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\""
    ));
    assert!(!p.contains("Bearer $REDLINE_DAEMON_TOKEN"));
    assert!(
        p.contains("/v1/sessions/<id>/suggestions"),
        "plan-suggestion exclusion"
    );
    assert!(p.contains("NEVER: /v1/browser/*"));
    // The old blanket read-only line is gone in favor of the new contract.
    assert!(p.contains("WRITE only at the user's explicit"));
    assert!(p.contains("staged, reviewable artifact"));
}

/// The grounding stack, in order: catalog, recap, evidence, question. The
/// evidence sits closest to what it answers; the recap between the catalog
/// and the question, exactly as `memchat.rs` pins it.
#[test]
fn first_turn_stacks_catalog_recap_evidence_then_the_question() {
    let p = build_first_turn_prompt(
        &surface("chat", None, None),
        SELF_ID,
        "",
        "and the beta?",
        &FirstTurnGround {
            catalog: Some("- Loop Engineering [n-loop] (12 links)\n"),
            recap: Some("\nCONVERSATION SO FAR — rotated for speed.\n\n- They said: hi\n"),
            prefetch: Some("PREFETCHED EVIDENCE\n- searched: beta\n"),
            mission: None,
            brief: Some("WORKSPACE BRIEF: read by Redline\nRepos (recently worked in):\n- redline · main · clean · /r\n"),
            attached: Some("## Context — This draft\n\nShip the beta\n"),
        },
    );
    let attached = p.find("Context the user attached").expect("attachment");
    let brief = p.find("WORKSPACE BRIEF").expect("brief block");
    let catalog = p.find("THEIR CATALOG").expect("catalog block");
    assert!(attached < brief, "what they attached sits with where they are");
    assert!(brief < catalog, "the workspace brief leads the record");
    let recap = p.find("CONVERSATION SO FAR").expect("recap block");
    let evidence = p
        .find("PREFETCHED EVIDENCE\n- searched")
        .expect("evidence block");
    let question = p.find("The user says:").expect("question");
    assert!(catalog < recap, "catalog above the recap");
    assert!(recap < evidence, "recap above the evidence");
    assert!(evidence < question, "evidence directly above the question");
    assert!(p.contains("- Loop Engineering [n-loop] (12 links)"));

    // A plain first turn carries none of the three blocks.
    let plain = build_first_turn_prompt(
        &surface("chat", None, None),
        SELF_ID,
        "",
        "and the beta?",
        &FirstTurnGround::default(),
    );
    assert!(!plain.contains("THEIR CATALOG"));
    assert!(!plain.contains("CONVERSATION SO FAR"));
    assert!(!plain.contains("- searched: beta"));
    assert!(!plain.contains("WORKSPACE BRIEF"));
}

#[test]
fn history_grounding_distinguishes_persisted_plans_from_an_empty_sidebar() {
    let text = plan_history_grounding(Ok((245, 610, 903)), 0);
    assert!(text.contains("245 plan sessions"));
    assert!(text.contains("610 revisions"));
    assert!(text.contains("Loaded session list: 0"));
    assert!(text.contains("loading/state mismatch, not deletion"));
    assert!(text.contains("not a supported history-list route"));
    assert!(text.contains("do not need sqlite3"));
    let error = plan_history_grounding(Err("no such column: effort".into()), 0);
    assert!(error.contains("UNKNOWN, not zero"));
    assert!(error.contains("no such column: effort"));
    assert!(!error.contains("Persisted database: 0"));
    assert!(plan_history_grounding(Ok((245, 610, 903)), 245).contains("counts currently agree"));
}

#[test]
fn chat_pacing_preserves_required_work_and_does_not_change_the_selected_model() {
    assert!(CHAT_INVESTIGATION_POLICY.contains("answer as soon as"));
    assert!(CHAT_INVESTIGATION_POLICY.contains("short public progress update"));
    assert!(CHAT_INVESTIGATION_POLICY.contains("never private reasoning"));
    assert!(CHAT_INVESTIGATION_POLICY
        .contains("Do not repeat empty, unsupported, or permission-denied queries"));
    assert!(CHAT_INVESTIGATION_POLICY.contains("Preserve the work needed"));
    let followup = build_followup_prompt(
        &surface("chat", None, None),
        SELF_ID,
        None,
        "",
        None,
        "Why is history empty?",
    );
    // Said once, in the system prompt; a follow-up no longer re-sends it.
    assert!(system_prompt().contains(CHAT_INVESTIGATION_POLICY));
    assert!(!followup.contains(CHAT_INVESTIGATION_POLICY));
    // The policy is prompt framing only; model/effort argv stay on the
    // existing per-chat seat override path tested below.
    assert!(!CHAT_INVESTIGATION_POLICY.contains("--model"));
    assert!(!CHAT_INVESTIGATION_POLICY.contains("--max-turns"));
}

/// The invariant contract is the system prompt: byte-identical on every
/// call (the cacheable prefix, and what lets a pre-warmed child match its
/// turn), carrying the whole contract and none of a turn's variables.
#[test]
fn the_system_prompt_is_the_invariant_contract() {
    let a = system_prompt();
    assert_eq!(a, system_prompt());
    assert!(a.contains("/v1/global/consult"));
    assert!(a.contains("/v1/memory/answer-pack"));
    assert!(a.contains("never call ExitPlanMode."));
    assert!(a.contains("PREFETCHED EVIDENCE"));
    assert!(a.contains("WORKSPACE BRIEF"));
    assert!(!a.contains("The user is currently on"));
    assert!(!a.contains("WHILE YOU WERE AWAY"));
    // The brainstorm posture: diverge, then converge.
    assert!(a.contains("diverge, then converge"));
    assert!(a.contains("compact table"));
    assert!(a.contains("assumptions and unknowns"));
    assert!(a.contains("**Next moves**"));
    assert!(a.contains("cite it BY NAME"));
    assert!(a.contains("Short by default"));
    // A first turn's body starts with variable content; nothing of the
    // contract leaks back into it.
    let body = build_first_turn_prompt(
        &surface("drafter", None, None),
        SELF_ID,
        "",
        "another question",
        &FirstTurnGround::default(),
    );
    assert!(body.starts_with("The user is currently on"));
    assert!(!body.contains("/v1/memory/answer-pack"));
}

#[test]
fn followup_regrounds_on_surface_without_reembedding_the_role() {
    let s = surface("drafter", None, None);
    let p = build_followup_prompt(&s, SELF_ID, None, "", None, "and now?");
    assert!(p.contains("the Prompt Drafter"));
    assert!(!p.contains("WORKSPACE CHANGES"), "an unchanged workspace adds nothing");
    let changed = build_followup_prompt(&s, SELF_ID, None, "", Some("WORKSPACE CHANGES since the last brief\n- x\n"), "and now?");
    assert!(changed.find("WORKSPACE CHANGES").unwrap() < changed.find("The user says:").unwrap());
    // The surface id rides every turn — follow-up writes need it too.
    assert!(p.contains("[surface id: x-1]"));
    assert!(!p.contains("COMPANION"), "role is not re-embedded");
    assert!(
        !p.contains("/v1/global/consult"),
        "routes are not re-embedded"
    );
    assert!(p.ends_with("> and now?\n"));
}

// --- Attached context ----------------------------------------------------

const PLAN_BLOCK: &str = "## Context — This plan (v3, Warm chat)\n\nPlan session: s-7\n\n# Warm chat\n- keep a child per room";

/// What the user attached from the card rides the prompt right under the
/// surface line it came from, on a first turn and a follow-up alike.
#[test]
fn attached_context_sits_under_the_surface_line_in_both_prompts() {
    let s = surface("plan", Some("Warm chat"), None);
    let first = build_first_turn_prompt(
        &s,
        SELF_ID,
        "WHILE YOU WERE AWAY — what the user did since your last turn:\n- browsed to X\n",
        "is this sound?",
        &FirstTurnGround {
            brief: Some("WORKSPACE BRIEF: read by Redline\n"),
            attached: Some(PLAN_BLOCK),
            ..Default::default()
        },
    );
    let followup = build_followup_prompt(
        &s,
        SELF_ID,
        Some(PLAN_BLOCK),
        "WHILE YOU WERE AWAY — what the user did since your last turn:\n- browsed to X\n",
        Some("WORKSPACE CHANGES since the last brief\n- x\n"),
        "and now?",
    );
    for p in [&first, &followup] {
        let header = p
            .find("Context the user attached from the plan review — Warm chat:")
            .expect("the attachment names where it came from");
        assert!(p.find("[surface id: x-1]").unwrap() < header, "after the surface line");
        assert!(header < p.find("Plan session: s-7").unwrap());
        assert!(p.find("</attached-context>").unwrap() < p.find("WHILE YOU WERE AWAY").unwrap());
        assert!(p.find("WHILE YOU WERE AWAY").unwrap() < p.find("The user says:").unwrap());
    }
    assert!(first.find("</attached-context>").unwrap() < first.find("WORKSPACE BRIEF").unwrap());

    // Nothing attached, or only whitespace, adds nothing.
    for attached in [None, Some("  \n")] {
        let plain = build_followup_prompt(&s, SELF_ID, attached, "", None, "and now?");
        assert!(!plain.contains("attached"), "{plain}");
        let plain = build_first_turn_prompt(
            &s,
            SELF_ID,
            "",
            "and now?",
            &FirstTurnGround { attached, ..Default::default() },
        );
        assert!(!plain.contains("attached"), "{plain}");
    }
}

/// The attachment is the prompt's alone: the stored row — and so the bubble
/// a remount restores — is exactly what the user typed, queued or not.
#[test]
fn attached_context_never_reaches_the_stored_message() {
    let db = Database::open_in_memory().unwrap();
    db.insert_companion(&chat("c1")).unwrap();
    let payload = QueuedCompanionSend {
        mode: TurnMode::Chat,
        message_id: "m1".into(),
        text: "is this sound?".into(),
        cwd: None,
        surface: surface("plan", Some("Warm chat"), None),
        harness: ConversationHarness::default(),
        browser_target: None,
        context: Some(PLAN_BLOCK.into()),
        context_all: None,
    };
    let row = user_message("c1", &payload);
    db.insert_companion_message(&row).unwrap();
    db.insert_companion_message(&CompanionMessage {
        id: "m2".into(),
        status: "queued".into(),
        ..user_message("c1", &payload)
    })
    .unwrap();
    let thread = db.load_companion_thread("c1").unwrap();
    assert_eq!(thread.len(), 2);
    for stored in &thread {
        assert_eq!(stored.body, "is this sound?");
        assert_eq!(stored.surface_kind.as_deref(), Some("plan"));
    }
    // The recap a rotated session carries is built from those rows, so it
    // can't smuggle the attachment back in as something the user said.
    assert!(!build_recap(&thread).contains("Plan session"));

    // A steered send has no turn framing, so it carries its own.
    let steered = steer_text(&payload);
    assert!(steered.starts_with("is this sound?\n\nContext the user attached from the plan review"));
    assert!(steered.contains("Plan session: s-7"));
    let bare = QueuedCompanionSend { context: None, ..payload };
    assert_eq!(steer_text(&bare), "is this sound?");
}

/// The turn that starts a fresh CLI session — here the rotation at the
/// turn budget — carries every pressed chip, not only what the chat
/// hasn't been handed: the new session never saw the earlier sends. A
/// resumed session gets only what is new.
#[test]
fn a_rotating_send_carries_the_whole_attachment() {
    let db = Database::open_in_memory().unwrap();
    db.insert_companion(&chat("c1")).unwrap();
    db.set_companion_session("c1", "sid-1").unwrap();
    let mut thread = Vec::new();
    for i in 0..ROTATE_AFTER_ASSISTANT_TURNS {
        thread.push(msg(&format!("u{i}"), "c1", "user", "q", i * 2));
        thread.push(msg(&format!("a{i}"), "c1", "assistant", "a", i * 2 + 1));
    }
    let turns = completed_assistant_turns(&thread);
    assert!(turns - db.get_companion_rotated_at("c1") >= ROTATE_AFTER_ASSISTANT_TURNS, "this send rotates");
    reset_companion_session(&db, "c1", turns);
    let fresh = db.get_companion_session("c1").is_none();
    assert!(fresh);

    // The plan went out turns ago; this send adds only the page.
    let page = "## Context — This page (Docs)\n\nhttps://docs.test";
    let all = format!("{PLAN_BLOCK}\n\n{page}");
    let attached = turn_attachment(fresh, Some(page.into()), Some(all.clone()));
    let s = surface("plan", Some("Warm chat"), None);
    let prompt = build_first_turn_prompt(
        &s,
        SELF_ID,
        "",
        "and now?",
        &FirstTurnGround { attached: attached.as_deref(), recap: Some("\nCONVERSATION SO FAR — rotated for speed.\n"), ..Default::default() },
    );
    assert!(prompt.contains("Plan session: s-7"), "the earlier plan rides the fresh session: {prompt}");
    assert!(prompt.contains("https://docs.test"));

    // Resumed, only the new block goes; and an older client that sends
    // no `contextAll` still attaches what it sent.
    assert_eq!(turn_attachment(false, Some(page.into()), Some(all)).as_deref(), Some(page));
    assert_eq!(turn_attachment(true, Some(page.into()), None).as_deref(), Some(page));
}

// --- Rotation ------------------------------------------------------------

/// The budget counts COMPLETED assistant turns, so a queued, unsent or
/// errored row can't spend it.
#[test]
fn rotation_fires_at_the_turn_budget() {
    let mut thread = Vec::new();
    for i in 0..(ROTATE_AFTER_ASSISTANT_TURNS - 1) {
        thread.push(msg(&format!("u{i}"), "c1", "user", "q", i * 2));
        thread.push(msg(&format!("a{i}"), "c1", "assistant", "a", i * 2 + 1));
    }
    assert!(
        completed_assistant_turns(&thread) < ROTATE_AFTER_ASSISTANT_TURNS,
        "one short of the budget must not rotate"
    );
    thread.push(msg("u-last", "c1", "user", "q", 100));
    let mut done = msg("a-last", "c1", "assistant", "a", 101);
    thread.push(done.clone());
    assert_eq!(
        completed_assistant_turns(&thread),
        ROTATE_AFTER_ASSISTANT_TURNS
    );
    // A queued row and an errored row are not turns the CLI replays.
    done.id = "a-err".into();
    done.status = "error".into();
    thread.push(done.clone());
    done.id = "u-queued".into();
    done.role = "user".into();
    done.status = "queued".into();
    thread.push(done);
    assert_eq!(
        completed_assistant_turns(&thread),
        ROTATE_AFTER_ASSISTANT_TURNS,
        "only completed assistant rows spend the budget"
    );

    // The reset drops only the CLI session; the thread survives, and the
    // mark records where the new session began so the NEXT rotation is a
    // full budget away rather than firing on every subsequent turn.
    let db = Database::open_in_memory().unwrap();
    db.insert_companion(&chat("c1")).unwrap();
    db.set_companion_session("c1", "sid-1").unwrap();
    db.insert_companion_message(&thread[0]).unwrap();
    reset_companion_session(&db, "c1", ROTATE_AFTER_ASSISTANT_TURNS);
    assert!(
        db.get_companion_session("c1").is_none(),
        "CLI session rotated"
    );
    assert_eq!(
        db.load_companion_thread("c1").unwrap().len(),
        1,
        "history survives"
    );
    assert_eq!(
        db.get_companion_rotated_at("c1"),
        ROTATE_AFTER_ASSISTANT_TURNS
    );
}

/// The mark is PER THREAD. memchat's is a single global setting because Ask
/// is a singleton; chats are not, and a shared mark would let two chats
/// rotate each other.
#[test]
fn two_chats_rotate_independently() {
    let db = Database::open_in_memory().unwrap();
    db.insert_companion(&chat("c1")).unwrap();
    db.insert_companion(&chat("c2")).unwrap();
    db.set_companion_session("c1", "sid-1").unwrap();
    db.set_companion_session("c2", "sid-2").unwrap();

    reset_companion_session(&db, "c1", 12);
    assert!(db.get_companion_session("c1").is_none());
    assert_eq!(db.get_companion_rotated_at("c1"), 12);
    // The other chat is untouched — session AND mark.
    assert_eq!(db.get_companion_session("c2").as_deref(), Some("sid-2"));
    assert_eq!(db.get_companion_rotated_at("c2"), 0);

    // And the mark dies with its row, so a recreated chat can never inherit
    // a count above its own turn count and refuse to rotate forever.
    db.delete_companion("c1").unwrap();
    db.insert_companion(&chat("c1")).unwrap();
    assert_eq!(db.get_companion_rotated_at("c1"), 0);
}

/// The recap must carry the tail of the conversation, bounded, and say
/// plainly that its contents are not evidence.
#[test]
fn recap_is_present_and_bounded() {
    let long_body = "x".repeat(RECAP_BODY_CHARS * 3);
    let mut thread = Vec::new();
    for i in 0..10 {
        thread.push(msg(
            &format!("u{i}"),
            "c1",
            "user",
            &format!("thought {i}"),
            i * 2,
        ));
        thread.push(msg(
            &format!("a{i}"),
            "c1",
            "assistant",
            &long_body,
            i * 2 + 1,
        ));
    }
    let recap = build_recap(&thread);
    assert!(recap.contains("CONVERSATION SO FAR — rotated for speed"));
    assert!(recap.contains("needing re-verification"));
    // Only the tail, oldest-of-the-tail first.
    assert!(
        recap.contains("thought 9"),
        "the newest exchange is carried"
    );
    assert!(!recap.contains("thought 0"), "the head is not");
    assert_eq!(
        recap.matches("They said").count(),
        RECAP_EXCHANGES,
        "exactly the budgeted exchanges"
    );
    assert!(recap.find("thought 7").unwrap() < recap.find("thought 9").unwrap());
    // Bodies are clipped, so a long transcript can't ride along whole.
    assert!(recap.contains('…'));
    assert!(
        recap.len() < RECAP_EXCHANGES * 2 * (RECAP_BODY_CHARS + 200),
        "the recap must stay bounded: {} bytes",
        recap.len()
    );
    // Nothing to recap is empty, not a header with no content.
    assert!(build_recap(&[]).is_empty());
}

/// A rotated first turn is a normal first turn PLUS the recap, in the slot
/// between the catalog and the question.
#[test]
fn rotated_first_turn_carries_the_recap_between_catalog_and_question() {
    let thread = vec![
        msg("u1", "c1", "user", "what about the anchoring thing?", 1),
        msg(
            "a1",
            "c1",
            "assistant",
            "You landed on prepared overlays.",
            2,
        ),
    ];
    let recap = build_recap(&thread);
    let p = build_first_turn_prompt(
        &surface("chat", None, None),
        SELF_ID,
        "",
        "and now?",
        &FirstTurnGround {
            catalog: Some("- A [a] (1 links)\n"),
            recap: Some(&recap),
            ..Default::default()
        },
    );
    assert!(p.contains("You landed on prepared overlays."));
    let catalog = p.find("THEIR CATALOG").unwrap();
    let recap_at = p.find("CONVERSATION SO FAR").unwrap();
    let question = p.find("The user says:").unwrap();
    assert!(catalog < recap_at && recap_at < question);
}

// --- Queue ---------------------------------------------------------------

/// The type-ahead lifecycle end to end at the registry + row level: a send
/// behind a busy slot queues in order, its persisted row is `queued`, the
/// drain re-reserves the slot and flips the row to `complete`, and an
/// unqueue takes the row with it.
#[test]
fn companion_queue_round_trip() {
    let db = Database::open_in_memory().unwrap();
    db.insert_companion(&chat("c1")).unwrap();
    let turns: Arc<Turns<QueuedCompanionSend>> = Arc::new(Turns::new());

    // Turn 1 takes the slot.
    let first = turns.begin("c1").expect("free slot");
    let token = first.token();

    // Turn 2 arrives mid-stream and queues, with a persisted `queued` row.
    let queued_turn = QueuedTurn {
        message_id: "m2".to_string(),
        text: "and the beta?".to_string(),
        queued_at: 2,
    };
    let payload = QueuedCompanionSend {
        mode: TurnMode::Chat,
        text: "and the beta?".to_string(),
        cwd: None,
        message_id: "m2".into(), surface: SurfaceInfo::default(), harness: ConversationHarness::default(),
        browser_target: None,
        context: None,
        context_all: None,
    };
    match turns.begin_or_enqueue("c1", queued_turn, payload) {
        SendSlot::Enqueued => {}
        _ => panic!("a busy slot must enqueue, not start"),
    }
    let mut queued_row = msg("m2", "c1", "user", "and the beta?", 2);
    queued_row.status = "queued".to_string();
    db.insert_companion_message(&queued_row).unwrap();
    assert_eq!(
        turns.status("c1").queued.len(),
        1,
        "the send is visible as queued"
    );

    // A remount sees the bubble.
    let thread = db.load_companion_thread("c1").unwrap();
    assert_eq!(thread.len(), 1);
    assert_eq!(thread[0].status, "queued");

    // Turn 1 ends: the reap pops the head and re-reserves in one section.
    drop(first);
    let (_, next) = turns.finish_and_pop("c1", token);
    let (drained, payload, _slot) = next.expect("the queue head drains");
    assert_eq!(drained.message_id, "m2");
    assert_eq!(payload.text, "and the beta?");
    assert!(
        db.set_thread_message_status("companion", "m2", "complete")
            .unwrap(),
        "the `companion` kind must be mapped, or the drained row stays a phantom chip"
    );
    assert_eq!(
        db.load_companion_thread("c1").unwrap()[0].status,
        "complete"
    );

    // And an unqueue takes the row with it.
    let turns2: Arc<Turns<QueuedCompanionSend>> = Arc::new(Turns::new());
    let held = turns2.begin("c1").expect("free slot");
    turns2.begin_or_enqueue(
        "c1",
        QueuedTurn {
            message_id: "m3".to_string(),
            text: "wait, scratch that".to_string(),
            queued_at: 3,
        },
        QueuedCompanionSend {
            mode: TurnMode::Chat,
            text: "wait, scratch that".to_string(),
            cwd: None,
            message_id: "m3".into(), surface: SurfaceInfo::default(), harness: ConversationHarness::default(),
            browser_target: None,
            context: None,
            context_all: None,
        },
    );
    let mut row3 = msg("m3", "c1", "user", "wait, scratch that", 3);
    row3.status = "queued".to_string();
    db.insert_companion_message(&row3).unwrap();
    let pulled = turns2.unqueue("c1", "m3").expect("still queued");
    assert_eq!(pulled.text, "wait, scratch that");
    assert!(db.delete_thread_message("companion", "m3").unwrap());
    assert_eq!(db.load_companion_thread("c1").unwrap().len(), 1);
    // Too late is `None`, not an error.
    assert!(turns2.unqueue("c1", "m3").is_none());
    drop(held);
}

/// The chat's own row carries its seat override, and the effective model
/// the ledger stamps follows it — not the seat's.
#[test]
fn per_chat_model_override_round_trips_and_drives_provenance() {
    let db = Database::open_in_memory().unwrap();
    db.insert_companion(&chat("c1")).unwrap();
    assert_eq!(db.get_companion_seat("c1"), (None, None));

    db.set_companion_seat("c1", Some("opus"), Some("high"))
        .unwrap();
    let (model, effort) = db.get_companion_seat("c1");
    assert_eq!(model.as_deref(), Some("opus"));
    assert_eq!(effort.as_deref(), Some("high"));
    assert_eq!(
        db.list_companions().unwrap()[0].model.as_deref(),
        Some("opus"),
        "the override rides the row the dropdown reads"
    );

    // The flags the spawn appends, and the model the lake records, both
    // follow the override rather than the seat.
    let flags =
        crate::seat::flag_args_override("companion", model.as_deref(), effort.as_deref());
    assert_eq!(
        flags,
        vec!["--model", "opus", "--effort", "high"],
        "the override builds the same flags a seat would"
    );
    assert_eq!(
        crate::seat::model_for_override("companion", model.as_deref(), effort.as_deref())
            .as_deref(),
        Some("opus"),
    );

    // Clearing it falls back to the seat (unconfigured here → no flags).
    db.set_companion_seat("c1", None, None).unwrap();
    assert_eq!(db.get_companion_seat("c1"), (None, None));
    assert!(crate::seat::flag_args_override("companion", None, None).is_empty());
}

/// A user rename outranks the auto-titling pass, permanently.
#[test]
fn a_user_rename_beats_the_auto_title() {
    let db = Database::open_in_memory().unwrap();
    db.insert_companion(&chat("c1")).unwrap();
    // The provisional title is replaceable by the titling pass…
    assert!(db
        .set_companion_title("c1", "Anchoring rework", false)
        .unwrap());
    assert_eq!(db.list_companions().unwrap()[0].title, "Anchoring rework");
    // …until the user names it themselves.
    assert!(db.set_companion_title("c1", "My thing", true).unwrap());
    assert!(
        !db.set_companion_title("c1", "Something a model liked", false)
            .unwrap(),
        "the auto-title must not overwrite a user-set name"
    );
    assert_eq!(db.list_companions().unwrap()[0].title, "My thing");
}

/// The consult's self-guard: a chat that is mid-turn refuses. That is the
/// self-consult case by construction — the only way a consult can name a
/// busy chat is that the chat IS the caller, writing the curl from inside
/// its own turn.
#[test]
fn a_busy_chat_refuses_to_consult_itself() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    db.insert_companion(&chat("c1")).unwrap();
    let state = CompanionState::new(db);
    // Its own turn holds the slot.
    let held = state.turns.begin("c1").expect("free slot");
    assert!(state.is_running("c1"));
    let err = tauri::async_runtime::block_on(
        state.consult("c1".to_string(), "what did we conclude?".to_string()),
    )
    .expect_err("a busy chat must refuse");
    assert!(err.contains("busy"), "{err}");
    assert!(err.contains("your own conversation"), "{err}");
    drop(held);
    assert!(!state.is_running("c1"));
}

/// A consult with nothing to ask is refused before anything is reserved or
/// persisted.
#[test]
fn a_consult_needs_a_question() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    db.insert_companion(&chat("c1")).unwrap();
    let state = CompanionState::new(db.clone());
    let err =
        tauri::async_runtime::block_on(state.consult("c1".to_string(), "   ".to_string()))
            .expect_err("an empty question is refused");
    assert!(err.contains("nothing to ask"));
    assert!(!state.is_running("c1"), "the slot was never reserved");
    assert!(db.load_companion_thread("c1").unwrap().is_empty());
}

/// The titling pass is the cheapest spawn in the app: no tool surface at
/// all, which is what makes `bypassPermissions` safe here.
#[test]
fn the_titling_spawn_has_no_tool_surface() {
    let args = title_args(None, Vec::new());
    let tools = args
        .iter()
        .position(|a| a == "--tools")
        .expect("--tools is pinned");
    assert_eq!(
        args[tools + 1],
        "",
        "an empty tool surface, not a narrowed one"
    );
    assert!(args.contains(&"--no-session-persistence".to_string()));
    assert!(args.contains(&"--strict-mcp-config".to_string()));
    // Unconfigured seat -> a fast model; a configured one wins outright.
    assert!(args
        .windows(2)
        .any(|w| w[0] == "--model" && w[1] == "haiku"));
    let configured = title_args(
        Some("opus".to_string()),
        vec!["--model".to_string(), "opus".to_string()],
    );
    assert!(
        !configured
            .windows(2)
            .any(|w| w[0] == "--model" && w[1] == "haiku"),
        "a configured seat must not get a second --model: {configured:?}"
    );
}

#[test]
fn a_title_is_squeezed_into_a_dropdown_row() {
    assert_eq!(
        clean_title("Anchoring Rework").as_deref(),
        Some("Anchoring Rework")
    );
    // Quotes, emphasis, trailing punctuation and preamble lines all go.
    assert_eq!(
        clean_title("\n  **\"Anchoring Rework.\"**  \n").as_deref(),
        Some("Anchoring Rework")
    );
    // Bounded, so a model that ignores the instruction can't write an essay
    // into the dropdown.
    let long = clean_title(&"word ".repeat(60)).unwrap();
    assert!(long.chars().count() <= 60, "{long}");
    // Nothing usable leaves the provisional title standing.
    assert!(clean_title("   \n  ").is_none());
    assert!(clean_title("").is_none());
}

/// The voice thread route the routes block advertises must actually
/// resolve. `voice_messages` names its body column `text`, so an arm
/// without the alias would have produced `no such column: body`.
#[test]
fn the_advertised_voice_thread_route_resolves() {
    fn vm(id: &str, role: &str, text: &str, at: i64) -> crate::state::VoiceMessage {
        crate::state::VoiceMessage {
            id: id.to_string(),
            session_key: "plan-1".to_string(),
            role: role.to_string(),
            text: text.to_string(),
            created_at: at,
        }
    }
    let db = Database::open_in_memory().unwrap();
    db.insert_voice_message(&vm("v1", "you", "read me the plan", 1))
        .unwrap();
    db.insert_voice_message(&vm("v2", "agent", "Here it is.", 2))
        .unwrap();
    let msgs = db
        .load_thread_generic("voice", "plan-1", 50)
        .unwrap()
        .expect("the voice arm exists");
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].role, "you");
    assert_eq!(
        msgs[0].body, "read me the plan",
        "`text` reads through as `body`"
    );
    assert_eq!(db.thread_stats("voice", "plan-1").unwrap().0, 2);
    // …and the block that advertises it still does.
    assert!(routes_block().contains("/v1/context/threads/voice/<id>"));
}
#[test]
fn origin_chat_excerpt_preserves_first_user_and_recent_messages_with_utf8_bounds() {
    let mut messages = vec![msg("u1", "c1", "user", "First decision: local only 🧠", 1)];
    for index in 0..50 { messages.push(msg(&format!("m{index}"), "c1", "assistant", &"🧠 recent context ".repeat(80), index + 2)); }
    messages.push(msg("last", "c1", "user", "The latest direction", 100));
    let text = origin_chat_excerpt(&messages, 4000);
    assert!(text.len() <= 4000);
    assert!(text.contains("First decision: local only 🧠"));
    assert!(text.contains("The latest direction"));
    assert!(text.contains("earlier messages omitted"));
    for limit in 0..100 { assert!(origin_chat_excerpt(&messages, limit).len() <= limit); }
}

#[test]
fn origin_chat_uses_only_companion_parents_and_complete_messages() {
    let db = Database::open_in_memory().unwrap();
    db.insert_companion(&chat("c1")).unwrap();
    db.insert_companion_message(&msg("u1", "c1", "user", "Our decision", 1)).unwrap();
    let mut incomplete = msg("a1", "c1", "assistant", "Unfinished", 2);
    incomplete.status = "error".into();
    db.insert_companion_message(&incomplete).unwrap();
    crate::ledger::record_session_link(&db, "session", "from-chat", "companion", "c1").unwrap();
    crate::ledger::record_session_link(&db, "session", "from-draft", "drafter", "d1").unwrap();
    let origin = origin_chat_for_session(&db, "from-chat").unwrap();
    assert_eq!(origin.companion_id, "c1");
    assert_eq!(origin.messages.len(), 1);
    assert!(origin_chat_for_session(&db, "from-draft").is_none());
    assert!(origin_chat_for_session(&db, "unlinked").is_none());
}

#[test]
fn scripted_steer_reader_persists_assistant_user_assistant_order() {
    let db=Database::open_in_memory().unwrap();db.insert_companion(&chat("steer")).unwrap();
    let mut user=msg("queued","steer","user","Use the new direction",1);user.status="queued".into();db.insert_companion_message(&user).unwrap();
    let payload=QueuedCompanionSend{mode:TurnMode::Chat,message_id:user.id.clone(),text:user.body.clone(),cwd:None,surface:SurfaceInfo::default(),harness:ConversationHarness::default(),browser_target:None,context:None,context_all:None};
    let buf=Arc::new(Mutex::new(PartialBuf::new()));let mut results=0;
    for line in include_str!("../../scripts/fixtures/chat-steer.jsonl").lines(){let event:Value=serde_json::from_str(line).unwrap();match event["type"].as_str().unwrap(){
        "stream_event"=>{turn::push_delta(&buf,event["event"]["delta"]["text"].as_str().unwrap());},
        "steer"=>{let(_,body,seq)=persist_steer_segment(&db,"steer",&buf,&payload).unwrap();assert_eq!(body,"Before steer");assert_eq!(seq,1);},
        "result"=>{results+=1;db.insert_companion_message(&msg("final","steer","assistant",&buf.lock().unwrap().text,now_millis())).unwrap();},_=>{}
    }}
    let rows=db.load_companion_thread("steer").unwrap();assert_eq!(results,1);assert_eq!(rows.iter().map(|row|(row.role.as_str(),row.body.as_str())).collect::<Vec<_>>(),vec![("assistant","Before steer"),("user","Use the new direction"),("assistant","After steer")]);assert_eq!(buf.lock().unwrap().seq,2);
}
#[test]
fn handoff_seed_is_exact_idempotent_and_does_not_send_a_turn() {
    let db=Database::open_in_memory().unwrap();db.insert_companion(&chat("seed")).unwrap();let body="  Plan this\nwith attachments\n";
    let first=db.seed_companion_handoff("seed","nonce",body,Some("/project"),1).unwrap().unwrap();let again=db.seed_companion_handoff("seed","nonce",body,Some("/project"),20).unwrap().unwrap();
    assert_eq!(first.id,again.id);assert_eq!(first.created_at,again.created_at);assert_eq!(again.body,body);assert_eq!(db.load_companion_thread("seed").unwrap().len(),1);assert_eq!(db.companion_project("seed").as_deref(),Some("/project"));
    assert!(db.seed_companion_handoff("seed","nonce","different",None,30).unwrap().is_none());assert!(db.seed_companion_handoff("missing","other",body,None,40).unwrap().is_none());
}
