// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `fork.rs`'s `mod tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.


fn research_comment(id: &str, block: &str, excerpt: Option<&str>) -> crate::state::Comment {
    let mut c: crate::state::Comment = serde_json::from_value::<crate::state::NewCommentRequest>(serde_json::json!({
        "type": "question", "anchorId": "A.1", "blockId": block, "body": "q"
    }))
    .map(|r| crate::state::Comment {
        id: id.to_string(),
        kind: r.kind,
        scope: None,
        anchor_id: r.anchor_id,
        block_id: r.block_id,
        body: r.body,
        edit: None,
        structural: None,
        created_at: 0,
        status: crate::state::CommentStatus::Draft,
        resolution: None,
        selection: None,
        reopen_note: None,
        reopen_history: Vec::new(),
        actionable: false,
        author: None,
        agent_state: None,
        reviewer: None,
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    })
    .unwrap();
    c.research = Some(crate::state::ResearchLink {
        query: "rate limits".into(),
        browse_id: "b-1".into(),
        url: None,
        answer_hash: excerpt.map(|_| "abcdef0123456789".into()),
        answer_excerpt: excerpt.map(str::to_string),
    });
    c
}

// --- Sidecar views: report and chat ------------------------------------

fn chat_msg(role: &str, body: &str) -> ThreadMessage {
    ThreadMessage { mode: Some("chat".into()), ..thread_msg(role, body, "complete") }
}

#[test]
fn turn_mode_reads_report_chat_and_the_retired_conversation_view() {
    assert_eq!(TurnMode::parse(None), Ok(TurnMode::Report));
    assert_eq!(TurnMode::parse(Some("report")), Ok(TurnMode::Report));
    assert_eq!(TurnMode::parse(Some("chat")), Ok(TurnMode::Chat));
    // A frontend from before Chat may still be mid-flight for a release.
    assert_eq!(TurnMode::parse(Some("conversation")), Ok(TurnMode::Report));
    for unknown in ["Chat", "", "summary"] {
        let err = TurnMode::parse(Some(unknown)).expect_err("an unknown mode is refused, not guessed");
        assert!(err.contains("unknown discussion mode"), "{err}");
    }
    // One spelling of a report: NULL, like every row from before the column.
    assert_eq!(TurnMode::Report.stamp(), None);
    assert_eq!(TurnMode::Chat.stamp().as_deref(), Some("chat"));
}

#[test]
fn a_report_thread_that_never_chatted_keeps_the_legacy_prompt() {
    let first = build_first_turn_prompt(true, "2", None, "Why?", None, &[], None);
    assert!(first.contains(&format!("\n{REPORT_VOICE} This is a read-only discussion thread")));
    assert_eq!(mode_prompt(first.clone(), TurnMode::Report, true, false), first);
    assert_eq!(mode_prompt("follow up".into(), TurnMode::Report, false, false), "follow up");
}

#[test]
fn a_chat_that_opens_the_thread_keeps_the_read_only_and_no_exit_plan_mode_lines() {
    let first = build_first_turn_prompt(true, "2", Some("quoted"), "This anchor drifts.", None, &[], None);
    let chat = mode_prompt(first, TurnMode::Chat, true, false);
    assert!(chat.contains(CHAT_VOICE));
    assert!(!chat.contains("`sidecar` skill"));
    for line in ["This is a read-only discussion thread", "do not edit files", "do not call ExitPlanMode"] {
        assert!(chat.contains(line), "lost `{line}`");
    }
    let sidecar = context_sidecar_prompt_with("cursor", "# Plan", &chat, true);
    assert!(sidecar.contains(CHAT_VOICE) && sidecar.contains("do not call ExitPlanMode"));
    // Follow-ups pass through; their directive is added last, elsewhere.
    assert_eq!(mode_prompt("quick?".into(), TurnMode::Chat, false, false), "quick?");
}

#[test]
fn a_chat_that_opens_the_thread_still_quotes_the_comment_it_is_about() {
    let mut comment = research_comment("c-1", "blk-1", None);
    comment.body = "  This anchor drifts. ".into();
    assert_eq!(discuss_seed(&comment), "This anchor drifts.");
    comment.body = "(edit)".into();
    comment.edit = Some(crate::state::EditPayload { original: "a".into(), revised: "b".into() });
    assert_eq!(discuss_seed(&comment), "Why change \"a\" to \"b\"?");
    comment.edit = None;
    assert_eq!(discuss_seed(&comment), "Let's talk through this part of the plan.");

    comment.body = "This anchor drifts.".into();
    let chat = opening_turn_prompt(&comment, "Why does it drift?\nAnd when?", TurnMode::Chat, &[], &[], "");
    assert!(chat.contains("Their comment:\n> This anchor drifts.\n"), "{chat}");
    assert!(
        chat.ends_with("\n\nThey opened a quick chat about it. Their question:\n> Why does it drift?\n> And when?\n"),
        "{chat}"
    );
}

#[test]
fn a_discuss_opening_keeps_the_prompt_every_discussion_has_had() {
    let mut comment = research_comment("c-1", "blk-1", None);
    comment.body = "This anchor drifts.".into();
    let legacy = build_first_turn_prompt(true, "A.1", None, "This anchor drifts.", None, &[], None);
    assert_eq!(
        opening_turn_prompt(&comment, "This anchor drifts.", TurnMode::Report, &[], &[], "\n\nresearch"),
        format!("{legacy}\n\nresearch"),
    );
}

/// "Write it up →" after an opening chat that never got a reply: no fork
/// exists yet, so the write-up IS turn one. Quoting the request as "their
/// comment" would leave the fork answering a comment it was never shown.
#[test]
fn a_write_up_that_opens_the_fork_still_quotes_the_comment() {
    let mut comment = research_comment("c-1", "blk-1", None);
    comment.body = "This anchor drifts.".into();
    let write_up = "Write this up — the full answer to my original comment given everything we've discussed, including our chat.";
    let prompt = opening_turn_prompt(&comment, write_up, TurnMode::Report, &[], &[], "");
    assert!(prompt.contains("Their comment:\n> This anchor drifts.\n"), "{prompt}");
    assert!(prompt.ends_with(&format!("\n\nTheir latest message:\n> {write_up}\n")), "{prompt}");
    assert!(prompt.contains(REPORT_VOICE));
}

/// A re-fork carries the thread's turns. One opened by "💬 Discuss" starts
/// on the comment; one opened in chat never sent it, so it goes in front.
#[test]
fn a_reforked_chat_thread_still_quotes_the_comment() {
    let mut comment = research_comment("c-1", "blk-1", None);
    comment.body = "This anchor drifts.".into();

    let chat_first = [chat_msg("user", "Even on reload?"), chat_msg("assistant", "Yes, on every reload.")];
    let prompt = opening_turn_prompt(&comment, "And on save?", TurnMode::Chat, &chat_first, &[], "");
    let quoted_at = prompt.find("Their comment:\n> This anchor drifts.\n").expect("the comment is quoted");
    assert!(quoted_at < prompt.find("This discussion already has history").unwrap());
    assert!(prompt.contains("\nReviewer (chat): Even on reload?"));
    assert!(prompt.contains("Their latest message:\n> And on save?\n"));
    assert!(!prompt.contains("They opened a quick chat"), "the history already says so");

    let discussed = [
        thread_msg("user", "This anchor drifts.", "complete"),
        thread_msg("assistant", "## Why it drifts", "complete"),
    ];
    let prompt = opening_turn_prompt(&comment, "And on save?", TurnMode::Report, &discussed, &[], "");
    assert!(!prompt.contains("Their comment:"), "{prompt}");
    assert!(prompt.contains("\nReviewer: This anchor drifts."));
}

#[test]
fn the_chat_directive_goes_last_after_the_monochat_recap() {
    let db = Database::open_in_memory().unwrap();
    for (id, role, body) in [("u", "user", "Plan the cache."), ("a", "assistant", "Cache at the edge.")] {
        db.insert_companion_message(&crate::state::CompanionMessage {
            id: id.into(),
            companion_id: "conv-1".into(),
            role: role.into(),
            body: body.into(),
            status: "complete".into(),
            surface_kind: None,
            surface_id: None,
            surface_label: None,
            created_at: 1,
        })
        .unwrap();
    }
    let recap_end = |p: &str| p.find("</monochat-context>").expect("the recap is in the prompt");

    let chat = finish_turn_prompt(&db, "s-1", "c-1", Some("conv-1"), TurnMode::Chat, None, "Why there?".into());
    assert!(chat.ends_with(&format!("\n\n{CHAT_DIRECTIVE}")), "{chat}");
    assert!(recap_end(&chat) < chat.rfind(CHAT_DIRECTIVE).unwrap());
    assert!(chat.starts_with("Why there?"));

    // A report turn gets no directive at all.
    let report = finish_turn_prompt(&db, "s-1", "c-1", Some("conv-1"), TurnMode::Report, None, "Why there?".into());
    assert!(!report.contains("(Chat —"));
    assert!(report.trim_end().ends_with("</monochat-context>"));

    // A separate sidecar gets the same sentence through its rewrite: no
    // skill to load, still last.
    let sidecar = finish_turn_prompt(&db, "s-1", "c-1", Some("conv-1"), TurnMode::Chat, Some(("cursor", "# Plan", true)), "Why there?".into());
    assert!(sidecar.ends_with("\n\n(Chat — quick back-and-forth. Answer in 1–4 sentences of plain prose; no headings, tables or diagrams unless asked.)"), "{sidecar}");
    assert!(!sidecar.contains("sidecar skill"));
    assert!(sidecar.find("<current-plan-context>").unwrap() < recap_end(&sidecar));
    assert!(recap_end(&sidecar) < sidecar.rfind("(Chat —").unwrap());

    // A seeded Claude sidecar has the Skill tool, so its chat turns keep
    // the guard against loading the report skill.
    let seeded = finish_turn_prompt(&db, "s-1", "c-1", Some("conv-1"), TurnMode::Chat, Some(("claude-code", "# Plan", false)), "Why there?".into());
    assert!(seeded.ends_with(&format!("\n\n{CHAT_DIRECTIVE}")), "{seeded}");
    assert!(seeded.find("<current-plan-context>").unwrap() < recap_end(&seeded));
}

#[test]
fn a_report_after_chat_folds_the_chat_in() {
    let seed = thread_msg("user", "This anchor drifts.", "complete");
    let write_up = thread_msg("assistant", "## Why it drifts", "complete");
    let asked = chat_msg("user", "Even on reload?");
    let answered = chat_msg("assistant", "Yes, on every reload.");
    let failed = thread_msg("assistant", "Claude stopped early.", "error");

    assert!(!chatted_since_write_up(&[seed.clone(), write_up.clone()]));
    assert!(chatted_since_write_up(&[seed.clone(), write_up.clone(), asked.clone(), answered.clone()]));
    // A thread that opened in chat has no write-up yet.
    assert!(chatted_since_write_up(&[asked.clone(), answered.clone()]));
    // Written up since: the chat is already folded in.
    assert!(!chatted_since_write_up(&[asked.clone(), answered.clone(), seed.clone(), write_up.clone()]));
    // A failed report turn is not a write-up.
    assert!(chatted_since_write_up(&[asked, answered, seed, failed]));

    let prompt = mode_prompt("Write this up.".into(), TurnMode::Report, false, true);
    assert_eq!(prompt, format!("{REPORT_AFTER_CHAT} {REPORT_VOICE}\n\nWrite this up."));
    let sidecar = context_sidecar_prompt_with("antigravity", "# Plan", &prompt, true);
    assert!(sidecar.contains(REPORT_AFTER_CHAT));
    assert!(sidecar.contains("For this reply, lead with the answer"));
    assert!(!sidecar.contains("`sidecar` skill"));
}

#[test]
fn a_reforked_thread_carries_its_chat_labelled_as_chat() {
    let block = continuity_block(&[
        thread_msg("user", "This anchor drifts.", "complete"),
        thread_msg("assistant", "## Why it drifts", "complete"),
        chat_msg("user", "Even on reload?"),
        chat_msg("assistant", "Yes, on every reload."),
    ])
    .unwrap();
    assert!(block.contains("\nReviewer: This anchor drifts."));
    assert!(block.contains("\nAssistant: ## Why it drifts"));
    assert!(block.contains("\nReviewer (chat): Even on reload?"));
    assert!(block.contains("\nAssistant (chat): Yes, on every reload."));
}

#[test]
fn research_block_cites_only_the_anchored_blocks_landed_answer_bounded() {
    let here = research_comment("c-1", "blk-1", Some("Limit is 100/min."));
    let elsewhere = research_comment("c-2", "blk-9", Some("unrelated"));
    let pending = research_comment("c-3", "blk-1", None);
    let mut target = research_comment("c-4", "blk-1", None);
    target.research = None;
    let all = [here.clone(), elsewhere, pending];
    let block = research_block(all.iter(), &target).expect("a landed answer on the block");
    assert!(block.contains("Limit is 100/min."));
    assert!(block.contains("[research abcdef012345]"));
    assert!(!block.contains("unrelated"));
    // Nothing landed nearby → the prompt is untouched.
    let other = research_comment("c-5", "blk-2", None);
    assert!(research_block(all.iter(), &other).is_none());
    // Bounded in total.
    let huge = research_comment("c-6", "blk-1", Some(&"x".repeat(10_000)));
    let block = research_block([huge.clone(), huge].iter(), &target).unwrap();
    let quoted: usize = block.lines().filter(|l| l.starts_with("> ")).map(|l| l.len() - 2).sum();
    assert!(quoted <= crate::state::RESEARCH_EXCERPT_MAX);
}
use super::*;

#[test]
fn missing_conversation_never_retries_an_identical_resume() {
    let error = "error_during_execution: No conversation found with session ID: missing-author";
    assert!(!should_retry(1, false, Some(error)));
    assert!(!should_retry(2, false, Some(error)));
}

#[test]
fn missing_author_seeds_a_fresh_discussion_then_resumes_only_its_own_session() {
    let prompt = context_sidecar_prompt_with("claude-code", "# Saved plan\n<!-- rl:blk-first -->", "Why this design?", false);
    let first = claude_plan_discussion_args_with("claude-code", "missing-author", None, prompt.clone(), Some("sonnet"), Some("high"), true);
    assert!(!first.iter().any(|a| a == "--resume" || a == "--fork-session" || a == "missing-author"));
    assert!(first.iter().any(|a| a.contains("# Saved plan") && a.contains("rl:blk-first") && a.contains("Why this design?")));
    assert!(prompt.contains("scoped local Redline memory bridge"));
    assert!(!prompt.contains("Shell commands and Skill are unavailable"));
    let next = claude_plan_discussion_args_with("claude-code", "missing-author", Some("seeded-thread"), "Follow up".into(), Some("sonnet"), Some("high"), true);
    assert_eq!(&next[next.len()-2..], &["--resume", "seeded-thread"]);
    assert!(!next.iter().any(|a| a == "--fork-session" || a == "missing-author"));
}

#[test]
fn discussion_model_effort_override_emits_once_for_first_and_followup() {
    for backend in ["claude-code", "cursor"] {
        for previous in [None, Some("discussion-id")] {
            let args = claude_plan_discussion_args_with(backend, "author-id", previous, "question".into(), Some("sonnet"), Some("high"), false);
            assert_eq!(args.iter().filter(|arg| *arg == "--model").count(), 1);
            assert_eq!(args.iter().filter(|arg| *arg == "--effort").count(), 1);
            assert!(args.windows(2).any(|pair| pair == ["--model", "sonnet"]));
            assert!(args.windows(2).any(|pair| pair == ["--effort", "high"]));
        }
    }
    let default = discussion_fork_args("fork_plan", "question".into());
    assert_eq!(default, discussion_fork_args_with("fork_plan", "question".into(), None, None));
    assert_eq!(default, discussion_fork_args_with("fork_plan", "question".into(), Some(" "), Some("")));
    assert_eq!(crate::seat::model_for_override("fork_plan", Some("sonnet"), Some("high")), Some("sonnet".into()));
}

#[test]
fn codex_discussion_effort_is_a_top_level_setting_with_or_without_model() {
    for model in [None, Some("gpt-6-astra")] {
        for subcommand in ["fork", "resume"] {
            let args = codex_discussion_fork_args_with(subcommand, "thread", "question".into(), model, Some("high"));
            let at = args.iter().position(|arg| arg == "model_reasoning_effort=\"high\"").unwrap();
            assert_eq!(args[at-1], "-c");
            assert!(at < args.iter().position(|arg| arg == "exec").unwrap());
            assert_eq!(args.iter().filter(|arg| arg.starts_with("model_reasoning_effort=")).count(), 1);
            assert_eq!(args.iter().filter(|arg| *arg == "-m").count(), usize::from(model.is_some()));
        }
    }
}

// stream-json line classification is covered by `claude_proc`'s own tests.

/// The draft-thread write contract authenticates via curl's own variable
/// import. It is built from a `format!` string, so the literal braces are
/// quadrupled in source; the wrong escape level renders `{TOKEN}` and the
/// suggestion silently 401s at runtime with nothing to see in the UI.
#[test]
fn draft_thread_prompt_imports_the_token_with_curl_not_the_shell() {
    let comment = crate::state::DraftComment {
        id: "c-1".to_string(),
        draft_id: "d-9".to_string(),
        block_id: Some("rl:blk-abc".to_string()),
        sel_char_start: None,
        sel_char_end: None,
        sel_quoted_text: Some("the selected line".to_string()),
        body: "tighten this".to_string(),
        author: None,
        created_at: 0,
        fork_session_id: None,
    };
    let p = build_draft_first_turn_prompt("d-9", &comment, "what about X?");

    // The URL stays immediately after `-s` so the command-prefix allow
    // rules still match, with the auth flags after it.
    assert!(p.contains("curl -s http://127.0.0.1:7676/v1/drafter/d-9/suggestions"));
    assert!(p.contains(
        "--variable %REDLINE_DAEMON_TOKEN= \
             --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\""
    ));
    // Shell expansion never survives the agent bash sandbox.
    assert!(!p.contains("Bearer $REDLINE_DAEMON_TOKEN"));
    // The scoping payload still round-trips its `format!` args.
    assert!(p.contains("\"commentId\":\"c-1\""));
}

/// The Phase-3 fork loosening must grant EXACTLY the scoped localhost-daemon
/// curl allow and nothing broader: no bare `Bash` allow, no other curl host,
/// and no write/plan tools in the tool set. This is the guard on the
/// consciously-widened read-only fork invariant.
#[test]
fn discussion_fork_args_grant_only_the_scoped_localhost_curl_allow() {
    let args = discussion_fork_args("fork_plan", "the prompt".to_string());

    // `-p <prompt>` leads; MCP is stripped; never plan mode.
    assert_eq!(args[0], "-p");
    assert_eq!(args[1], "the prompt");
    assert!(args.iter().any(|a| a == "--strict-mcp-config"));
    assert!(!args.iter().any(|a| a == "plan"), "must never be plan mode");

    // The `--tools` set: Bash is present (for curl) and Skill so the fork
    // can actually load its skill body, but no write/plan tools. Pin the
    // spawn site to the shared const so the two can't drift apart.
    let tools_idx = args.iter().position(|a| a == "--tools").unwrap();
    let tools = &args[tools_idx + 1];
    assert_eq!(tools, "Read,Grep,Glob,WebFetch,WebSearch,Bash,Skill");
    assert_eq!(*tools, crate::claude_proc::HEADLESS_TOOLS);
    for forbidden in ["Edit", "Write", "ExitPlanMode", "NotebookEdit", "Task"] {
        assert!(
            !tools.split(',').any(|t| t == forbidden),
            "`{forbidden}` must not be in the discussion-fork tool set"
        );
    }

    // The `--allowedTools` values run from just after the flag to the next
    // flag (`--strict-mcp-config`). It must be EXACTLY the two web tools plus
    // the three scoped-curl quoting variants — nothing else.
    let allow_idx = args.iter().position(|a| a == "--allowedTools").unwrap();
    let allow: Vec<&str> = args[allow_idx + 1..]
        .iter()
        .take_while(|a| !a.starts_with("--"))
        .map(String::as_str)
        .collect();
    assert_eq!(
        allow,
        vec![
            "WebSearch",
            "WebFetch",
            "Bash(curl -s http://127.0.0.1:7676/*)",
            "Bash(curl -s 'http://127.0.0.1:7676/*)",
            "Bash(curl -s \"http://127.0.0.1:7676/*)",
        ],
        "the allow-list must be exactly the web tools + the three scoped curl variants"
    );

    // No bare `Bash` allow (that would permit arbitrary commands), and every
    // Bash allow targets ONLY the localhost daemon.
    for a in &allow {
        if a.starts_with("Bash(") {
            assert!(
                a.contains("curl -s http://127.0.0.1:7676/")
                    || a.contains("curl -s 'http://127.0.0.1:7676/")
                    || a.contains("curl -s \"http://127.0.0.1:7676/"),
                "Bash allow `{a}` must be scoped to the localhost daemon"
            );
        }
    }
    assert!(
        !allow.iter().any(|a| *a == "Bash"),
        "a bare `Bash` allow would defeat the scoping — it must never appear"
    );
}

#[test]
fn fork_key_is_session_scoped() {
    // The same comment id in different sessions must not collide.
    assert_ne!(fork_key("s1", "c-001"), fork_key("s2", "c-001"));
    assert_eq!(fork_key("s1", "c-001"), fork_key("s1", "c-001"));
}

#[test]
fn thread_status_streams_while_registered_and_idles_after_removal() {
    // The status command is what lets a remounted thread rediscover an
    // in-flight turn after a session switch — it must mirror the registry
    // exactly: streaming (with the start stamp and buffered partial)
    // while the entry exists, idle the moment it's removed.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let turns: Arc<Turns<()>> = Arc::new(Turns::new());
        let idle = thread_status_in(&turns, "scope-1", "item-1");
        assert!(!idle.streaming);
        assert_eq!(idle.started_at, None);
        assert_eq!(idle.partial, None);

        let key = fork_key("scope-1", "item-1");
        let slot = turns.begin(&key).expect("begin");
        let buf = slot.buf();
        let child = tokio::process::Command::new("sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleep");
        slot.attach(child).expect("attach onto live reservation");
        turn::push_delta(&buf, "so far");

        let live = thread_status_in(&turns, "scope-1", "item-1");
        assert!(live.streaming);
        assert!(live.started_at.is_some());
        assert_eq!(live.partial.as_deref(), Some("so far"));
        assert_eq!(live.seq, 1);
        // Scoping holds: the same item id in another scope reads idle.
        assert!(!thread_status_in(&turns, "scope-2", "item-1").streaming);

        if let Some(mut child) = turns.take(&key).and_then(|p| p.child) {
            let _ = child.start_kill();
        }
        let done = thread_status_in(&turns, "scope-1", "item-1");
        assert!(!done.streaming);
        assert_eq!(done.started_at, None);
    });
}

#[test]
fn first_turn_prompt_carries_comment_and_guardrails() {
    let p = build_first_turn_prompt(
        true,
        "A.1",
        Some("the detail section"),
        "Why this order?",
        None,
        &[],
        None,
    );
    assert!(p.contains("Why this order?"));
    assert!(p.contains("the detail section"));
    assert!(p.contains("§A.1"));
    assert!(p.contains("asked a question"));
    // The read-only guardrail must always be present.
    assert!(p.contains("ExitPlanMode"));
    assert!(p.contains("do not edit files"));
}

#[test]
fn first_turn_prompt_without_selection_uses_anchor_only() {
    let p = build_first_turn_prompt(false, "B", None, "Reconsider this.", None, &[], None);
    assert!(p.contains("§B"));
    assert!(p.contains("left a comment"));
    assert!(p.contains("Reconsider this."));
}

fn review_ann(kind: &str) -> ReviewAnnotation {
    ReviewAnnotation {
        id: "rc-001".to_string(),
        review_id: "rev-1".to_string(),
        round: 1,
        file_path: "src/db.rs".to_string(),
        side: "new".to_string(),
        start_line: 42,
        end_line: 45,
        kind: kind.to_string(),
        body: String::new(),
        suggestion_replacement: if kind == "suggestion" {
            Some("let x = y?;".to_string())
        } else {
            None
        },
        quoted_text: "let x = y.unwrap();".to_string(),
        status: "draft".to_string(),
        resolution: None,
        created_at: 1,
        scope: "line".to_string(),
        label: None,
        blocking: None,
        source: "user".to_string(),
    }
}

#[test]
fn review_first_turn_prompt_grounds_on_the_diff_range() {
    let p = build_review_first_turn_prompt(&review_ann("suggestion"), "Safer this way?");
    assert!(p.contains("src/db.rs"));
    assert!(p.contains("lines 42-45"));
    assert!(p.contains("new side"));
    assert!(p.contains("> let x = y.unwrap();"));
    assert!(p.contains("> let x = y?;"));
    assert!(p.contains("Safer this way?"));
    assert!(p.contains("proposed a replacement"));
    // Read-only guardrails, same bar as plan threads.
    assert!(p.contains("ExitPlanMode"));
    assert!(p.contains("do not edit files"));
    // Grounding instruction: read the real file first.
    assert!(p.contains("reading the file"));
}

#[test]
fn review_first_turn_prompt_kind_variants() {
    let del = build_review_first_turn_prompt(&review_ann("deletion"), "why keep this?");
    assert!(del.contains("marked for deletion"));
    let mut single = review_ann("comment");
    single.end_line = 42;
    let c = build_review_first_turn_prompt(&single, "hm");
    assert!(c.contains("left a comment"));
    assert!(c.contains("line 42"));
    assert!(!c.contains("lines 42"));
}

#[test]
fn review_first_turn_prompt_carries_prior_resolution() {
    let mut ann = review_ann("comment");
    ann.resolution = Some("Fixed by using ?".to_string());
    let p = build_review_first_turn_prompt(&ann, "still crashes though");
    assert!(p.contains("previously resolved"));
    assert!(p.contains("Fixed by using ?"));
}

#[test]
fn first_turn_prompt_grounds_in_prior_resolution() {
    let p = build_first_turn_prompt(
        false,
        "A",
        None,
        "But what about retries?",
        Some("I added exponential backoff in §A."),
        &[],
        None,
    );
    assert!(p.contains("You previously resolved this comment with:"));
    assert!(p.contains("exponential backoff"));
}

// --- Codex plan-comment forks -----------------------------------------

fn thread_msg(role: &str, body: &str, status: &str) -> ThreadMessage {
    ThreadMessage {
        id: format!("m-{role}-{body}"),
        session_id: "s-1".to_string(),
        comment_id: "c-001".to_string(),
        role: role.to_string(),
        body: body.to_string(),
        status: status.to_string(),
        created_at: 0,
        attachments: Vec::new(),
        mode: None,
    }
}

/// Stored provenance is the only thing that can answer "which binary can
/// resume this id" — both id spaces are UUIDs — so an absent or unknown
/// value must land on Claude, which is what every pre-column row is.
#[test]
fn stored_backend_defaults_to_claude() {
    assert_eq!(ForkBackend::from_stored("codex"), ForkBackend::Codex);
    assert_eq!(ForkBackend::from_stored("Codex"), ForkBackend::Codex);
    assert_eq!(ForkBackend::from_stored(" codex "), ForkBackend::Codex);
    for legacy in ["", "  ", "claude-code", "anything-else"] {
        assert_eq!(
            ForkBackend::from_stored(legacy),
            ForkBackend::Claude,
            "`{legacy}` must read as claude"
        );
    }
    assert_eq!(ForkBackend::Codex.as_str(), "codex");
    assert_eq!(ForkBackend::Claude.as_str(), "claude-code");
}

#[test]
fn native_provider_discussions_never_resume_the_author_conversation() {
    for provider in ["cursor", "antigravity", " Antigravity "] {
        assert!(uses_claude_sidecar(provider));
        let first = claude_plan_discussion_args(provider, "native-author-id", None, "question".into());
        assert!(!first.iter().any(|arg| arg == "--resume" || arg == "--fork-session" || arg == "native-author-id"));
        let followup = claude_plan_discussion_args(provider, "native-author-id", Some("our-claude-sidecar"), "next".into());
        assert_eq!(&followup[followup.len()-2..], ["--resume", "our-claude-sidecar"]);
        let corrupt = claude_plan_discussion_args(provider, "native-author-id", Some("native-author-id"), "next".into());
        assert!(!corrupt.iter().any(|arg| arg == "--resume"));
        assert!(!stored_fork_matches(provider, ForkBackend::Claude));
    }
    assert!(stored_fork_matches("claude-code", ForkBackend::Claude));
    assert!(stored_fork_matches("", ForkBackend::Claude));
    assert!(!stored_fork_matches("codex", ForkBackend::Claude));
}

#[test]
fn native_context_sidecars_physically_omit_shell_skill_and_seat_tool_overrides() {
    let config = crate::seat::SeatConfig {
        model: Some("sonnet".into()), effort: Some("high".into()),
        extra_flags: Some(vec!["--tools".into(), "Bash,Skill,Write".into(),
            "--mcp-config".into(), "untrusted.json".into(), "--dangerously-skip-permissions".into()]),
        ..Default::default()
    };
    let args = context_sidecar_args_from("question".into(), crate::seat::flag_args_from(&config));
    assert_eq!(args.iter().filter(|arg| arg.as_str() == "--tools").count(), 1);
    assert!(args.windows(2).any(|pair| pair == ["--tools", CONTEXT_SIDECAR_TOOLS]));
    assert!(args.iter().any(|arg| arg == "--strict-mcp-config"));
    assert!(args.windows(2).any(|pair| pair == ["--model", "sonnet"]));
    assert!(args.windows(2).any(|pair| pair == ["--effort", "high"]));
    assert!(!args.iter().any(|arg| ["Bash", "Skill", "Write", "untrusted.json", "--mcp-config", "--dangerously-skip-permissions"].iter().any(|word| arg.contains(word))));
    for author in ["cursor", "antigravity", "codex"] {
        let args = claude_plan_consult_args(author, "native-author-id", "question".into());
        assert!(args.windows(2).any(|pair| pair == ["--tools", CONTEXT_SIDECAR_TOOLS]));
        assert!(!args.iter().any(|arg| arg == "--resume" || arg == "native-author-id"));
    }
    for author in ["cursor", "antigravity"] {
        for prior in [None, Some("our-sidecar")] {
            let args = claude_plan_discussion_args(author, "native-author-id", prior, "question".into());
            assert!(args.windows(2).any(|pair| pair == ["--tools", CONTEXT_SIDECAR_TOOLS]));
        }
    }
}

#[test]
fn context_sidecar_has_the_current_plan_anchor_and_visible_history_without_claiming_authorship() {
    let prompt = build_first_turn_prompt(true, "blk-api", Some("quoted selection"), "the question", Some("previous answer"), &[], Some("visible conversation history"));
    let seeded = context_sidecar_prompt("cursor", "# The current plan\n<!-- rl:blk-api -->", &prompt);
    for expected in ["authored with Cursor", "# The current plan", "blk-api", "quoted selection", "the question", "previous answer", "visible conversation history", "read-only", "never resume"] {
        assert!(seeded.contains(expected), "missing {expected}");
    }
    assert!(!seeded.contains("a plan you produced earlier"));
}

#[test]
fn codex_discussions_use_the_plan_model_instead_of_the_claude_seat() {
    // Reproduce the screenshot: a Claude seat set to opus on a Codex
    // plan. Follow-ups must override it too, since the failed first turn
    // may already have saved opus on the discussion's Codex rollout.
    for seat_model in ["opus", "sonnet", "haiku", "fable", "claude-opus-4-6"] {
        let model = plan_discussion_model(
            ForkBackend::Codex,
            Some(" gpt-6-astra "),
            Some(seat_model),
        );
        assert_eq!(model.as_deref(), Some("gpt-6-astra"));
        for (subcommand, thread_id) in [("fork", "plan-thread"), ("resume", "failed-discussion")] {
            let args = codex_discussion_fork_args(subcommand, thread_id, "question".into(), model.as_deref());
            assert!(args.windows(2).any(|pair| pair == ["-m", "gpt-6-astra"]));
            assert!(!args.iter().any(|arg| arg == seat_model));
            assert_eq!(args[args.len() - 2], thread_id);
        }
        // This same selection labels both the prompt ledger and meter.
        assert_eq!(crate::meter::from_codex_turn(&Value::Null, model.as_deref()).model, model);
    }
}

#[test]
fn codex_discussions_without_a_recorded_model_never_borrow_the_claude_seat() {
    for plan_model in [None, Some(""), Some(" \t ")] {
        let model = plan_discussion_model(ForkBackend::Codex, plan_model, Some("opus"));
        assert_eq!(model, None);
        for subcommand in ["fork", "resume"] {
            let args = codex_discussion_fork_args(subcommand, "thread", "question".into(), model.as_deref());
            assert!(!args.iter().any(|arg| arg == "-m" || arg == "--model" || arg == "opus"));
        }
    }
}

#[test]
fn claude_discussions_keep_their_seat_model_even_for_a_native_provider_sidecar() {
    assert_eq!(
        plan_discussion_model(ForkBackend::Claude, Some("author-model"), Some(" opus ")),
        Some("opus".into()),
    );
    assert_eq!(plan_discussion_model(ForkBackend::Claude, Some("author-model"), None), None);
    assert_eq!(plan_discussion_model(ForkBackend::Claude, Some("author-model"), Some(" ")), None);
}

#[test]
fn codex_explicit_model_is_before_exec_and_default_makes_no_claim() {
    let explicit = codex_discussion_fork_args("fork", "author-id", "question".into(), Some("gpt-6-astra"));
    let at = explicit.iter().position(|arg| arg == "-m").unwrap();
    assert_eq!(explicit[at+1], "gpt-6-astra");
    assert!(at < explicit.iter().position(|arg| arg == "exec").unwrap());
    let default = codex_discussion_fork_args("fork", "author-id", "question".into(), None);
    assert!(!default.iter().any(|arg| arg == "-m" || arg == "--model"));
    assert_eq!(crate::meter::from_codex_turn(&Value::Null, None).model, None);
}

/// The first Codex turn forks the PLAN thread. Every element here is
/// load-bearing and several are position-sensitive: `-s`/`-a`/`--search`/`-c`
/// are top-level options codex rejects after the subcommand, while `--json`
/// belongs to `exec fork`.
#[test]
fn codex_first_turn_forks_the_plan_thread_read_only() {
    let args = codex_discussion_fork_args("fork", "plan-thread-uuid", "the prompt".to_string(), None);

    // Sandbox + approvals: the physical half of "read-only discussion".
    let sandbox = args.iter().position(|a| a == "-s").expect("-s");
    assert_eq!(args[sandbox + 1], "read-only");
    let approval = args.iter().position(|a| a == "-a").expect("-a");
    assert_eq!(args[approval + 1], "never");
    // Web research parity with the Claude arm's WebSearch/WebFetch allow.
    assert!(args.iter().any(|a| a == "--search"));

    // The subcommand pair, the thread, then the prompt — in that order.
    let exec = args.iter().position(|a| a == "exec").expect("exec");
    assert_eq!(args[exec + 1], "fork");
    assert!(args[exec..].iter().any(|a| a == "--json"));
    assert!(args[exec..].iter().any(|a| a == "--skip-git-repo-check"));
    assert_eq!(args[args.len() - 2], "plan-thread-uuid");
    assert_eq!(args[args.len() - 1], "the prompt");

    // Top-level flags must all precede `exec`.
    for flag in ["-s", "-a", "--search", "-c"] {
        let at = args.iter().position(|a| a == flag).unwrap();
        assert!(at < exec, "`{flag}` is a top-level option and must precede `exec`");
    }

    // NEVER the plan profile: its contract would have this thread emit a
    // `<proposed_plan>` block, which the Stop hook captures as a revision
    // of the very plan being discussed.
    assert!(
        !args.iter().any(|a| a == "-p" || a == "--profile"),
        "the plan profile must not be layered onto a discussion fork"
    );
    assert!(!args.iter().any(|a| a.contains("redline-plan")));

    // The sidecar contract rides as TOML-quoted developer_instructions.
    let instructions = args
        .iter()
        .find(|a| a.starts_with("developer_instructions="))
        .expect("developer_instructions");
    let value = instructions.trim_start_matches("developer_instructions=");
    assert!(value.starts_with('"') && value.ends_with('"'), "must be TOML-quoted");
    let parsed: toml::Value =
        toml::from_str(&format!("k = {value}\n")).expect("must parse as TOML");
    let delivered = parsed["k"].as_str().unwrap();
    assert_eq!(delivered, CODEX_SIDECAR_INSTRUCTIONS);
    assert!(delivered.contains("<proposed_plan>"), "must forbid plan submission");
    assert!(delivered.contains("CONTEXT ONLY"), "inherited history is context");
    assert!(delivered.contains("Never edit"), "must forbid edits");
    assert!(delivered.contains("Markdown"), "must ask for a direct markdown answer");
}

/// Follow-ups resume the DISCUSSION's own thread — never re-fork the plan,
/// which would throw away everything already said.
#[test]
fn codex_follow_up_resumes_the_discussion_thread() {
    let first = codex_discussion_fork_args("fork", "plan-thread", "a".to_string(), None);
    let next = codex_discussion_fork_args("resume", "fork-thread", "b".to_string(), None);
    let exec = next.iter().position(|a| a == "exec").expect("exec");
    assert_eq!(next[exec + 1], "resume");
    assert_eq!(next[next.len() - 2], "fork-thread");
    // Identical otherwise: same sandbox, same instructions, same flags.
    assert_eq!(first.len(), next.len());
    assert_eq!(first[..exec], next[..exec]);
}

/// The Claude arm is untouched by the Codex work — the flag block, the
/// partial-message streaming and the fork/resume tail must all still be
/// exactly what they were.
#[test]
fn claude_first_turn_and_follow_up_args_are_unchanged() {
    let mut first = discussion_fork_args("fork_plan", "the prompt".to_string());
    first.extend([
        "--resume".to_string(),
        "plan-session".to_string(),
        "--fork-session".to_string(),
    ]);
    assert!(first.iter().any(|a| a == "--include-partial-messages"));
    assert_eq!(&first[first.len() - 3..], ["--resume", "plan-session", "--fork-session"]);

    let mut next = discussion_fork_args("fork_plan", "the prompt".to_string());
    next.extend(["--resume".to_string(), "fork-session-id".to_string()]);
    assert_eq!(&next[next.len() - 2..], ["--resume", "fork-session-id"]);
    assert!(!next.iter().any(|a| a == "--fork-session"));
    // And nothing Codex leaked into it.
    for codex_only in ["exec", "--json", "--search", "--skip-git-repo-check"] {
        assert!(!first.iter().any(|a| a == codex_only));
    }
}

/// The `codex exec --json` wire contract, from lines the real CLI emits
/// (captured against codex-cli 0.149.0-alpha.4.3).
#[test]
fn codex_jsonl_yields_the_fork_id_the_reply_and_errors_only() {
    let line = |raw: &str| classify_codex_line(&serde_json::from_str(raw).unwrap());

    assert_eq!(
        line(r#"{"type":"thread.started","thread_id":"01a0619d-69a5-7cd3"}"#),
        CodexLine::Thread("01a0619d-69a5-7cd3".to_string()),
    );
    assert_eq!(
        line(r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"The answer."}}"#),
        CodexLine::Message("The answer.".to_string()),
    );
    assert_eq!(
        line(r#"{"type":"turn.completed","usage":{"input_tokens":18612,"output_tokens":5}}"#),
        CodexLine::Completed,
    );

    // Noise a reviewer must never see rendered as an answer.
    for noise in [
        r#"{"type":"turn.started"}"#,
        r#"{"type":"item.started","item":{"type":"agent_message","text":"partial"}}"#,
        r#"{"type":"item.completed","item":{"type":"reasoning","text":"thinking out loud"}}"#,
        r#"{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}"#,
        r#"{"type":"item.completed","item":{"type":"web_search","query":"tcp"}}"#,
        r#"{"type":"item.completed","item":{"type":"todo_list","items":[]}}"#,
        r#"{"type":"thread.started"}"#,
        r#"{"type":"something.new"}"#,
    ] {
        assert_eq!(line(noise), CodexLine::Ignore, "must ignore: {noise}");
    }

    // Failures, in all three shapes.
    assert_eq!(
        line(r#"{"type":"turn.failed","error":{"message":"model overloaded"}}"#),
        CodexLine::Failed("model overloaded".to_string()),
    );
    assert_eq!(
        line(r#"{"type":"error","message":"no rollout found for thread id"}"#),
        CodexLine::Failed("no rollout found for thread id".to_string()),
    );
    assert_eq!(
        line(r#"{"type":"item.completed","item":{"type":"error","message":"sandbox denied"}}"#),
        CodexLine::Failed("sandbox denied".to_string()),
    );
    // A failure with nothing quotable still surfaces AS a failure.
    assert_eq!(
        line(r#"{"type":"turn.failed"}"#),
        CodexLine::Failed("codex reported an error".to_string()),
    );
}

/// An ordinary first turn must produce the prompt it always has — the
/// continuity block exists for the repair path only.
#[test]
fn continuity_is_absent_from_an_ordinary_first_turn() {
    let plain = build_first_turn_prompt(false, "A", None, "Why?", None, &[], None);
    let empty = build_first_turn_prompt(
        false,
        "A",
        None,
        "Why?",
        None,
        &[],
        continuity_block::<ThreadMessage>(&[]).as_deref(),
    );
    assert_eq!(plain, empty, "no usable history must change nothing");
    assert!(plain.contains("Their comment:"));
    assert!(!plain.contains("Their latest message:"));
}

/// Replacing a wrong-harness fork keeps the transcript the reviewer can
/// see: it rides into the new fork as context, bounded, and error rows —
/// which are Redline's own failure text, not something an agent said —
/// stay out.
#[test]
fn a_replacement_fork_inherits_the_visible_transcript_as_context() {
    let history = vec![
        thread_msg("user", "Why this order?", "complete"),
        thread_msg("assistant", "Because the parser needs it first.", "complete"),
        thread_msg("assistant", "claude exited abnormally: boom", "error"),
        thread_msg("assistant", "   ", "complete"),
    ];
    let block = continuity_block(&history).expect("history to carry");
    assert!(block.contains("CONTEXT ONLY"));
    assert!(block.contains("Reviewer: Why this order?"));
    assert!(block.contains("Assistant: Because the parser needs it first."));
    assert!(
        !block.contains("exited abnormally"),
        "Redline's own error rows are not conversation"
    );

    let p = build_first_turn_prompt(
        false,
        "A.1",
        None,
        "And what about retries?",
        None,
        &[],
        Some(&block),
    );
    assert!(p.contains("Their latest message:"));
    assert!(p.contains("And what about retries?"));
    assert!(p.contains("Because the parser needs it first."));
    // Still the same read-only guardrails.
    assert!(p.contains("do not edit files"));
}

/// The screenshot bug, guarded on every surface `fork.rs` backs: a raw
/// `error_during_execution` must never survive as the body of a
/// `thread_messages` row — it renders under a byline and peer agents read
/// it as context.
#[test]
fn a_transient_failure_is_humanised_for_every_thread_target() {
    let db = Database::open_in_memory().unwrap();
    for target in [
        ThreadTarget::PlanComment,
        ThreadTarget::ReviewAnnotation,
        ThreadTarget::ReviewQuestion,
        ThreadTarget::DraftComment,
    ] {
        let msg = describe_fork_error(&db, target, "s-1", "c-1", "error_during_execution");
        assert!(!msg.contains("error_during_execution"), "leaked: {msg}");
        assert!(!msg.contains('_'), "machine-looking token in: {msg}");
        assert!(msg.to_lowercase().contains("again"), "no way forward: {msg}");
    }
}

/// The overflow branch's recovery, per target: forget the stored fork so
/// the next turn starts a fresh discussion instead of re-`--resume`-ing a
/// context that already proved too big. A transient error must NOT do
/// this — the session is fine.
#[test]
fn overflow_clears_the_stored_fork_transient_keeps_it() {
    use crate::state::{
        AttachState, CodeReviewSession, Comment, CommentStatus, DraftComment, ReviewQuestion,
        ReviewSession, Revision, SessionStatus,
    };

    let db = Database::open_in_memory().unwrap();

    // Parent rows first — every thread table is foreign-keyed to the
    // session / review / draft it hangs off.
    db.upsert_session(&ReviewSession {
        session_id: "s-1".to_string(),
        project_path: "/repo".to_string(),
        project_name: "repo".to_string(),
        created_at: 1,
        revisions: Vec::new(),
        status: SessionStatus::InReview,
        attach_state: AttachState::Idle,
        updated_at: 1,
        run_state: None,
        backend: None,
        model: None,
        effort: None,
    })
    .unwrap();
    db.insert_revision(
        "s-1",
        &Revision {
            version_number: 1,
            received_at: 1,
            raw_plan_markdown: "# plan".to_string(),
            sections: Vec::new(),
            comments: Vec::new(),
            thread_start: true,
            restored: false,
        },
    )
    .unwrap();
    db.upsert_code_review(&CodeReviewSession {
        review_id: "rev-1".to_string(),
        repo_path: "/repo".to_string(),
        source: "uncommitted".to_string(),
        base_ref: None,
        commit_sha: None,
        terminal_id: None,
        round: 1,
        created_at: 1,
    })
    .unwrap();
    db.upsert_draft("d-1", Some("draft"), None, "# draft", None).unwrap();

    // --- plan comment ---
    db.insert_comment(
        "s-1",
        1,
        &Comment {
            id: "c-1".to_string(),
            kind: CommentKind::Feedback,
            scope: None,
            anchor_id: "A.1".to_string(),
            block_id: None,
            body: "why?".to_string(),
            structural: None,
            edit: None,
            created_at: 1,
            status: CommentStatus::Draft,
            resolution: None,
            selection: None,
            reopen_note: None,
            reopen_history: Vec::new(),
            actionable: false,
            author: None,
            agent_state: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
            research: None,
        },
    )
    .unwrap();
    db.set_comment_fork("s-1", "c-1", "fork-sid", "claude-code").unwrap();
    describe_fork_error(&db, ThreadTarget::PlanComment, "s-1", "c-1", "error_during_execution");
    assert!(
        db.get_comment_fork("s-1", "c-1").is_some(),
        "a transient error must keep the session"
    );
    describe_fork_error(
        &db,
        ThreadTarget::PlanComment,
        "s-1",
        "c-1",
        "prompt is too long: 1200000 tokens",
    );
    assert!(db.get_comment_fork("s-1", "c-1").is_none());

    // --- review annotation ---
    db.insert_review_annotation(&ReviewAnnotation {
        id: "rc-1".to_string(),
        review_id: "rev-1".to_string(),
        round: 1,
        file_path: "src/main.rs".to_string(),
        side: "new".to_string(),
        start_line: 1,
        end_line: 1,
        kind: "comment".to_string(),
        body: "why?".to_string(),
        suggestion_replacement: None,
        quoted_text: "let x = 1;".to_string(),
        status: "draft".to_string(),
        resolution: None,
        created_at: 1,
        scope: "line".to_string(),
        label: None,
        blocking: None,
        source: "user".to_string(),
    })
    .unwrap();
    db.set_review_annotation_fork_session("rev-1", "rc-1", "fork-sid").unwrap();
    describe_fork_error(
        &db,
        ThreadTarget::ReviewAnnotation,
        "rev-1",
        "rc-1",
        "maximum context length exceeded",
    );
    assert!(db.get_review_annotation_fork_session("rev-1", "rc-1").is_none());

    // --- review question (the clear helper this fix had to add) ---
    db.insert_review_question(&ReviewQuestion {
        id: "rq-1".to_string(),
        review_id: "rev-1".to_string(),
        file_path: "src/main.rs".to_string(),
        side: "new".to_string(),
        start_line: 1,
        end_line: 1,
        quoted_text: "let x = 1;".to_string(),
        created_at: 1,
    })
    .unwrap();
    db.set_review_question_fork_session("rev-1", "rq-1", "fork-sid").unwrap();
    describe_fork_error(
        &db,
        ThreadTarget::ReviewQuestion,
        "rev-1",
        "rq-1",
        "error_during_execution",
    );
    assert!(
        db.get_review_question_fork_session("rev-1", "rq-1").is_some(),
        "a transient error must keep the session"
    );
    describe_fork_error(
        &db,
        ThreadTarget::ReviewQuestion,
        "rev-1",
        "rq-1",
        "the prompt is too long",
    );
    assert!(db.get_review_question_fork_session("rev-1", "rq-1").is_none());

    // --- draft comment (the other clear helper this fix had to add) ---
    db.insert_draft_comment(&DraftComment {
        id: "dc-1".to_string(),
        draft_id: "d-1".to_string(),
        block_id: None,
        sel_char_start: None,
        sel_char_end: None,
        sel_quoted_text: None,
        body: "tighten this".to_string(),
        author: None,
        created_at: 1,
        fork_session_id: None,
    })
    .unwrap();
    db.set_draft_comment_fork_session("dc-1", "fork-sid").unwrap();
    describe_fork_error(
        &db,
        ThreadTarget::DraftComment,
        "d-1",
        "dc-1",
        "error_during_execution",
    );
    assert!(
        db.get_draft_comment_fork_session("dc-1").is_some(),
        "a transient error must keep the session"
    );
    describe_fork_error(
        &db,
        ThreadTarget::DraftComment,
        "d-1",
        "dc-1",
        "input exceeds the context window",
    );
    assert!(db.get_draft_comment_fork_session("dc-1").is_none());
}

/// The auto-retry's whole decision, in one place. The `streamed` guard is
/// the load-bearing one: retrying after text is on screen would make the
/// answer rewrite itself.
#[test]
fn a_transient_failure_retries_once_and_only_with_nothing_on_screen() {
    // Transient, nothing streamed → retry.
    assert!(should_retry(1, false, Some("error_during_execution")));
    assert!(should_retry(1, false, Some("model overloaded, please retry")));
    // …but only once.
    assert!(!should_retry(2, false, Some("error_during_execution")));
    // Partial text already on screen → never.
    assert!(!should_retry(1, true, Some("error_during_execution")));
    // Not transient → never. An overflow would fail identically on a
    // resume, and a hard failure is not a blip.
    assert!(!should_retry(1, false, Some("prompt is too long")));
    assert!(!should_retry(1, false, Some("claude exited abnormally: boom")));
    // No error at all → nothing to retry.
    assert!(!should_retry(1, false, None));
}

/// Bounded on both axes: a long thread carries its most recent turns, and
/// one enormous turn cannot crowd out the rest.
#[test]
fn continuity_is_bounded_by_turns_and_by_size() {
    let mut history: Vec<ThreadMessage> = (0..20)
        .map(|i| thread_msg("user", &format!("turn{i}"), "complete"))
        .collect();
    history.push(thread_msg("assistant", &"x".repeat(5_000), "complete"));
    let block = continuity_block(&history).expect("history");
    assert!(block.contains("turn19"), "the newest turns are the ones kept");
    assert!(!block.contains("turn0:"), "the oldest turns are dropped");
    assert!(block.contains('…'), "an oversized turn is truncated, not dropped");
    assert!(block.len() < 8_000, "the block stays bounded: {}", block.len());
}
