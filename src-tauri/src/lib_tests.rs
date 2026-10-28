// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `lib.rs`'s `mod tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;
use crate::db::Database;

#[tokio::test]
async fn browser_preparation_serializes_same_target_without_blocking_other_targets() {
    let first = preparation_lock("wake:browser-fixture-one");
    let same = preparation_lock("wake:browser-fixture-one");
    let other = preparation_lock("wake:browser-fixture-two");
    assert!(Arc::ptr_eq(&first, &same));
    let guard = first.lock().await;
    assert!(tokio::time::timeout(std::time::Duration::from_millis(5), same.lock()).await.is_err());
    assert!(other.try_lock().is_ok());
    drop(guard);
    assert!(same.try_lock().is_ok());
}

/// `IN_ORDER_COMMANDS` calls run in the order their tickets were taken,
/// whatever order the pool starts them in, and a call that panics still
/// passes the turn on.
#[test]
fn in_order_calls_run_in_ticket_order() {
    let tickets: Vec<u64> = (0..4).map(|_| IN_ORDER_TICKETS.fetch_add(1, Ordering::Relaxed)).collect();
    let ran = Arc::new(StdMutex::new(Vec::new()));
    let fails = tickets[1];
    // Newest first, each given a moment to reach its turn and wait.
    let calls: Vec<_> = tickets
        .iter()
        .rev()
        .map(|&ticket| {
            let ran = ran.clone();
            let call = std::thread::spawn(move || {
                in_turn(ticket, || {
                    if ticket == fails {
                        std::panic::resume_unwind(Box::new("a failed save"));
                    }
                    ran.lock().unwrap().push(ticket);
                    true
                })
            });
            std::thread::sleep(std::time::Duration::from_millis(5));
            call
        })
        .collect();
    for call in calls {
        call.join().expect("in_turn contains the panic");
    }
    assert_eq!(*ran.lock().unwrap(), vec![tickets[0], tickets[2], tickets[3]]);
}

/// `GET /v1/perf` evaluates script in the app's own webview, so the only
/// caller input — the window — must arrive as a clamped integer.
#[test]
fn perf_probe_script_reads_the_probe_with_a_clamped_window() {
    let default = perf_probe_script(None);
    assert!(default.contains("window.__rlPerf"));
    assert!(default.contains("p.snapshot(60000)"));
    assert!(default.contains("running:false"));
    assert!(perf_probe_script(Some(5)).contains("p.snapshot(1000)"));
    assert!(perf_probe_script(Some(30_000)).contains("p.snapshot(30000)"));
    assert!(perf_probe_script(Some(u64::MAX)).contains("p.snapshot(120000)"));
}

/// The selection bar is a user script like any other, so what it costs to
/// get wrong is a tab that silently loses it. These pin the *set* — the one
/// part of `install_user_scripts` that isn't objc.
#[test]
fn browser_user_scripts_includes_the_selection_bar_only_when_enabled() {
    let on = browser_user_scripts("", true);
    assert!(on.iter().any(|(src, _)| src.contains("__redline_sel_installed")));
    let off = browser_user_scripts("", false);
    assert!(!off.iter().any(|(src, _)| src.contains("__redline_sel_installed")));
    // Both shims survive either way — the toggle is not allowed to drop them.
    for set in [&on, &off] {
        assert!(set.iter().any(|(src, _)| src.contains("__redline_fs_installed")));
        assert!(set.iter().any(|(src, _)| src.contains("__redline_newtab_installed")));
        assert!(set.iter().any(|(src, main_only)| src.contains("__redline_frontdoor_shortcut_installed") && !main_only));
    }
}

#[test]
fn browser_user_scripts_keeps_the_view_filter_conditional_and_main_frame_only() {
    // No filter → no view script at all (an empty css is a *reset*, applied
    // by eval, never registered).
    assert!(!browser_user_scripts("", true)
        .iter()
        .any(|(src, _)| src.contains("__redline_view__")));
    let with_css = browser_user_scripts("html{filter:invert(100%)}", true);
    let view = with_css
        .iter()
        .find(|(src, _)| src.contains("__redline_view__"))
        .expect("view filter script");
    assert!(view.1, "the filter must not invert ad/embed iframes");
    // …and neither may the selection bar sprout a second copy in one.
    let sel = with_css
        .iter()
        .find(|(src, _)| src.contains("__redline_sel_installed"))
        .expect("selection script");
    assert!(sel.1, "the selection bar is main frame only");
    // The fullscreen embed handshake and the new-tab relay need every frame.
    for (src, main_only) in &with_css {
        if src.contains("__redline_fs_installed") || src.contains("__redline_newtab_installed") {
            assert!(!main_only);
        }
    }
}

#[test]
fn selection_shim_carries_its_guard_and_every_action_id() {
    let js = selection_shim_js();
    // The double install (user script *and* the eval into the loaded page)
    // must be a no-op the second time.
    assert!(js.contains("if (window.__redline_sel_installed) return;"));
    // …but the runtime off-switch is cleared BEFORE that guard, or
    // re-checking the setting could never revive an installed shim.
    let cleared = js
        .find("__redline_sel_off = false")
        .expect("off-switch clear");
    let guard = js
        .find("if (window.__redline_sel_installed) return;")
        .unwrap();
    assert!(cleared < guard);
    for action in [
        "'ask'",
        "'define'",
        "'explain'",
        "'research'",
        "'copy'",
        "'list'",
    ] {
        assert!(js.contains(action), "missing action {action}");
    }
    // Every queued action lands on the queue the pane drains.
    assert!(js.contains("window.__redline_selections"));
    // The one line that makes the whole gesture work.
    assert!(js.contains("e.preventDefault(); e.stopPropagation(); },true);"));
    // ＋ List asks for the note instead of filing the highlighted passage as
    // one: the passage is WHERE, the note is WHAT.
    assert!(js.contains("if (action==='list'||action==='ask'){ openNote(action); return; }"));
    // The side-pane composer reads its location from this, so it has to be
    // published on every evaluate AND cleared when the selection goes.
    assert!(js.contains("window.__redline_sel_last"));
    assert!(js.contains("pending=null; publish(); hide(); return;"));
    // The material the pointer is resolved from.
    for field in ["testId:", "landmark:", "heading:", "path:", "classes:"] {
        assert!(js.contains(field), "locator is missing {field}");
    }
    // Typing a note must not re-place the bar under the caret.
    assert!(js.contains("if (composing) return;"));
}

#[test]
fn selection_teardown_flips_the_runtime_flag() {
    let js = selection_teardown_js();
    assert!(js.contains("__redline_sel_off = true"));
    assert!(js.contains("data-redline-selection"));
    // With no bar there is no way to see what is highlighted, so nothing
    // may still be silently anchoring to it.
    assert!(js.contains("__redline_sel_last = null"));
}

/// `same_tab_url` has to agree with `sameTabUrl` in browseList.ts, because
/// the frontend's dedupe decides whether the active label changes and this
/// decides whether that counts as success. A drift between the two shows up
/// as `/v1/browser/open` reporting a timeout on a focus that worked.
#[test]
fn same_tab_url_matches_a_dev_server_by_port() {
    // The reported bug, in three strings: the card links one, the poll
    // rewrites the tab to another, a redirect produces the third.
    assert!(same_tab_url(
        "http://localhost:3000",
        "http://localhost:3000/"
    ));
    assert!(same_tab_url(
        "http://localhost:3000",
        "http://localhost:3000/dashboard"
    ));
    assert!(same_tab_url("http://127.0.0.1:3000/x", "http://localhost:3000"));
    assert!(same_tab_url("https://localhost:3000", "http://localhost:3000"));
    // Different port is a different server, loopback or not.
    assert!(!same_tab_url(
        "http://localhost:3000",
        "http://localhost:5173"
    ));
    // Loopback and public are two different machines.
    assert!(!same_tab_url("http://localhost:3000", "http://example.com:3000"));
}

#[test]
fn same_tab_url_is_strict_off_loopback() {
    assert!(same_tab_url("https://example.com/a/", "https://example.com/a"));
    assert!(same_tab_url(
        "https://example.com/a#top",
        "https://example.com/a"
    ));
    assert!(same_tab_url("https://example.com:443/a", "https://example.com/a"));
    // A public site's paths are separate pages — only loopback collapses
    // them, and only because a dev server's identity is its port.
    assert!(!same_tab_url("https://example.com/a", "https://example.com/b"));
    assert!(!same_tab_url(
        "https://example.com/a?x=1",
        "https://example.com/a?x=2"
    ));
    assert!(!same_tab_url("https://example.com/a", "http://example.com/a"));
    // Unparseable on either side falls back to exact equality: never widen
    // a match we can't reason about.
    assert!(!same_tab_url("not a url", "https://example.com"));
    assert!(same_tab_url("not a url", "not a url"));
}

/// A failed ledger write must leave BOTH launch guards disarmed. Both exist
/// to make the spawned session's own hook fire *skip* this body; arming
/// them before the write meant a failed write left them armed for the 300s
/// TTL, the hook skipped the prompt, and the prompt existed nowhere — the
/// launch succeeded, the plan arrived, and nothing recorded what was asked.
/// Ordering is the whole fix, so ordering is what's pinned.
#[test]
fn a_failed_ledger_write_leaves_both_launch_guards_disarmed() {
    const SRC: &str = include_str!("lib.rs");
    let body = SRC
        .split_once("fn record_plan_launch(")
        .expect("record_plan_launch exists")
        .1;
    let record = body.find("ledger::record_prompt(&db, input)").expect("records");
    let agent_guard = body.find("ledger::register_agent_prompt(&body)").expect("arms");
    let launch_guard = body.find("ledger::register_plan_launch(").expect("arms");
    assert!(
        record < agent_guard && record < launch_guard,
        "record_prompt must run BEFORE either guard is armed"
    );
    // ...and the failure must be visible to Shipwright/Librarian, not just
    // returned to a caller that used to drop it.
    let friction = body.find("record_friction(").expect("friction on the error path");
    assert!(friction < agent_guard, "friction is on the early-return path");
}

/// The suggestions endpoint teaches snake_case but agents long saw
/// `blockId`/`agentId` — both casings must deserialize, or block ops 400
/// on casing alone.
#[test]
fn draft_suggestion_req_accepts_both_casings() {
    let snake: DraftSuggestionReq = serde_json::from_str(
        r#"{"op":"replace_block","block_id":"blk-1","agent_id":"a","comment_id":"c","markdown":"x"}"#,
    )
    .unwrap();
    assert_eq!(snake.block_id.as_deref(), Some("blk-1"));
    assert_eq!(snake.agent_id.as_deref(), Some("a"));
    assert_eq!(snake.comment_id.as_deref(), Some("c"));
    let camel: DraftSuggestionReq = serde_json::from_str(
        r#"{"op":"replace_block","blockId":"blk-1","agentId":"a","commentId":"c","markdown":"x"}"#,
    )
    .unwrap();
    assert_eq!(camel.block_id.as_deref(), Some("blk-1"));
    assert_eq!(camel.agent_id.as_deref(), Some("a"));
    assert_eq!(camel.comment_id.as_deref(), Some("c"));
}

/// Golden: the exact UserPromptSubmit payload captured from claude 2.1.199
/// (docs/protocol-verification.md). The submitted text is at `prompt` — NOT
/// `user_input` as the public docs claim. Building against `user_input`
/// alone would capture empties; this pins the empirical reality.
#[test]
fn ingest_reads_prompt_field_from_real_payload() {
    let golden = serde_json::json!({
        "session_id": "fbf661e8-3152-4f0d-bc43-e1bc07008f5a",
        "transcript_path": "/Users/x/.claude/projects/p/s.jsonl",
        "cwd": "/Users/x/proj",
        "prompt_id": "37137840-65f2-43a0-b280-7a3b7ad1564f",
        "permission_mode": "default",
        "hook_event_name": "UserPromptSubmit",
        "prompt": "say hi in one word"
    });
    assert_eq!(ingest_prompt_text(&golden), "say hi in one word");
    // Forward-compat: a hypothetical `user_input`-only payload still works.
    let alt = serde_json::json!({ "user_input": "  spaced  " });
    assert_eq!(ingest_prompt_text(&alt), "spaced");
    // No text → empty (the handler skips empties).
    assert_eq!(ingest_prompt_text(&serde_json::json!({ "prompt": "   " })), "");
    assert_eq!(ingest_prompt_text(&serde_json::json!({})), "");
}

/// Snapshot enrichment truncation must be char-boundary safe (never split a
/// multi-byte codepoint) and only ellipsize when it actually clips.
#[test]
fn snap_truncate_is_char_boundary_safe() {
    // Short strings pass through, trimmed, no ellipsis.
    assert_eq!(snap_truncate("  hello  ", 80), "hello");
    // Over-length ASCII clips to max chars (incl. the ellipsis).
    let clipped = snap_truncate("abcdefghij", 5);
    assert_eq!(clipped.chars().count(), 5);
    assert!(clipped.ends_with('…'));
    // Multi-byte text never panics and stays valid UTF-8 at the boundary.
    let emoji = "😀😀😀😀😀😀";
    let t = snap_truncate(emoji, 3);
    assert_eq!(t.chars().count(), 3);
    assert!(t.ends_with('…'));
    // Reading-time rounds up and never reports zero.
    assert_eq!(0u32.div_ceil(SNAP_WORDS_PER_MINUTE).max(1), 1);
    assert_eq!(1u32.div_ceil(SNAP_WORDS_PER_MINUTE).max(1), 1);
    assert_eq!(201u32.div_ceil(SNAP_WORDS_PER_MINUTE).max(1), 2);
}

/// The resume cwd comes from the FIRST cwd a transcript records — the
/// directory the session was launched from. A session that `cd`s elsewhere
/// (the dialcrown case: started in `~`, worked in `~/dialcrown`) is still
/// only resumable from where it started.
#[test]
fn startup_cwd_is_the_first_one_recorded_not_the_last() {
    let dir = std::env::temp_dir().join(format!("rl-resume-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    let path = dir.join("t.jsonl");
    std::fs::write(
        &path,
        concat!(
            // Claude Code's opening record carries no cwd at all.
            "{\"type\":\"mode\",\"mode\":\"default\"}\n",
            "{\"type\":\"user\",\"cwd\":\"/Users/me\"}\n",
            "{\"type\":\"assistant\",\"cwd\":\"/Users/me\"}\n",
            "{\"type\":\"user\",\"cwd\":\"/Users/me/dialcrown\"}\n",
        ),
    )
    .unwrap();
    assert_eq!(
        startup_cwd_from_transcript(&path).as_deref(),
        Some("/Users/me")
    );

    // An empty cwd is not an answer — keep looking.
    let blank = dir.join("blank.jsonl");
    std::fs::write(
        &blank,
        concat!(
            "{\"type\":\"user\",\"cwd\":\"\"}\n",
            "{\"type\":\"user\",\"cwd\":\"/Users/me/repo\"}\n",
        ),
    )
    .unwrap();
    assert_eq!(
        startup_cwd_from_transcript(&blank).as_deref(),
        Some("/Users/me/repo")
    );

    // No cwd anywhere, unparseable lines, and a missing file all decline
    // rather than guess — the caller falls back to the project path.
    let none = dir.join("none.jsonl");
    std::fs::write(&none, "{\"type\":\"user\"}\nnot json\n").unwrap();
    assert_eq!(startup_cwd_from_transcript(&none), None);
    assert_eq!(startup_cwd_from_transcript(&dir.join("nope.jsonl")), None);

    let _ = std::fs::remove_dir_all(&dir);
}

/// The detached-delivery error names the harness that actually left, and
/// keeps the phrase the frontend's `isDetachError` matches on.
#[test]
fn detached_delivery_error_names_the_right_harness() {
    let codex = detached_delivery_error("codex");
    assert!(codex.starts_with("Codex is no longer waiting"));
    assert!(codex.contains("the Codex session ended"));
    // Never Claude's name on a Codex reviewer's failure.
    assert!(!codex.contains("Claude"));

    // Claude, and every legacy/unknown row, keep the sentence they had.
    for backend in ["claude-code", "", "gemini"] {
        let msg = detached_delivery_error(backend);
        assert!(msg.starts_with("Claude is no longer waiting"), "{backend}");
        assert!(msg.contains("the Claude Code session ended"), "{backend}");
    }

    // The banner trigger. `isDetachError` (src/App.tsx) substring-matches
    // this; losing it on either arm leaves the reviewer with a dead
    // in-review screen and no Restore button.
    for backend in ["codex", "claude-code"] {
        assert!(detached_delivery_error(backend).contains("no longer waiting"));
        assert!(detached_delivery_error(backend).contains("Restore plan session"));
    }
}

/// `prepare_restore` branches on the harness before it touches a single
/// file. The Claude arm answers from `~/.claude`; the Codex arm declines to
/// look, because every question it could ask there has a Claude-shaped
/// answer and a Codex thread would fail all of them for the wrong reason.
#[test]
fn prepare_restore_only_reads_claude_files_for_a_claude_session() {
    // An id no transcript can exist for, so the Claude arm is guaranteed to
    // reach its "looked, found nothing" branch.
    let id = format!("rl-no-such-session-{}", uuid::Uuid::new_v4());
    let project = Some("/Users/me/redline".to_string());

    // Codex: the plan's project directory, and NO claim about history.
    let codex = prepare_restore(id.clone(), project.clone(), Some("codex".to_string()));
    assert_eq!(codex.cwd.as_deref(), Some("/Users/me/redline"));
    assert_eq!(codex.history, RestoreHistory::Unchecked);
    // Nothing was relocated (no transcript was consulted to relocate to)
    // and no plan file was primed — Codex has none to prime.
    assert!(!codex.relocated);
    assert!(!codex.primed);

    // Claude, same id: it DID look, and says so. This is the contrast that
    // matters — `Missing` is what drives the reviewer-facing "resuming as a
    // fresh conversation" warning, and a Codex user must never see it.
    for backend in [None, Some("claude-code".to_string())] {
        let claude = prepare_restore(id.clone(), project.clone(), backend);
        assert_eq!(claude.history, RestoreHistory::Missing);
        assert_eq!(claude.cwd.as_deref(), Some("/Users/me/redline"));
        assert!(!claude.primed);
    }

    // An unknown harness is not Codex. Legacy rows and anything Redline
    // hasn't been taught fall to the Claude behaviour they've always had,
    // never to the arm that skips the lookup.
    assert_eq!(
        prepare_restore(id.clone(), project.clone(), Some("gemini".into())).history,
        RestoreHistory::Missing
    );

    // With no project path there is nothing to fall back to, and the Codex
    // arm says so rather than inventing a directory.
    let bare = prepare_restore(id, None, Some("codex".to_string()));
    assert_eq!(bare.cwd, None);
    assert_eq!(bare.history, RestoreHistory::Unchecked);
}

/// The three history states serialize to the strings the frontend switches
/// on. A silent rename here would degrade every restore message to its
/// fallback branch without failing anything.
#[test]
fn restore_history_serializes_as_the_ui_contract() {
    let j = |h: RestoreHistory| {
        serde_json::to_string(&ResumeTarget {
            cwd: None,
            history: h,
            relocated: false,
            primed: false,
        })
        .unwrap()
    };
    assert!(j(RestoreHistory::Available).contains("\"history\":\"available\""));
    assert!(j(RestoreHistory::Missing).contains("\"history\":\"missing\""));
    assert!(j(RestoreHistory::Unchecked).contains("\"history\":\"unchecked\""));
    // The old boolean is gone; nothing may still be reading it.
    assert!(!j(RestoreHistory::Available).contains("found"));
}

/// The plan file is read out of the transcript, last mention wins — a
/// session that changed plan files mid-life is on its newest one.
#[test]
fn plan_file_is_the_last_one_the_transcript_names() {
    let dir = std::env::temp_dir().join(format!("rl-planfile-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    let path = dir.join("t.jsonl");
    std::fs::write(
        &path,
        concat!(
            "{\"tool\":\"Write\",\"file_path\":\"/Users/me/.claude/plans/old-name.md\"}\n",
            "{\"text\":\"wrote /Users/me/.claude/plans/wild-treasure.md ok\"}\n",
            "{\"type\":\"user\",\"cwd\":\"/Users/me\"}\n",
        ),
    )
    .unwrap();
    assert_eq!(
        plan_file_from_transcript(&path).as_deref(),
        Some("/Users/me/.claude/plans/wild-treasure.md")
    );

    // A transcript that never entered plan mode has no plan file, and a
    // missing transcript is not an error — both fall back to asking the
    // model to write the marker itself.
    let bare = dir.join("bare.jsonl");
    std::fs::write(&bare, "{\"type\":\"user\",\"cwd\":\"/Users/me\"}\n").unwrap();
    assert_eq!(plan_file_from_transcript(&bare), None);
    assert_eq!(plan_file_from_transcript(&dir.join("nope.jsonl")), None);

    // Priming refuses to invent a plan file: a path that isn't there means
    // the resumed session will mint a name we can't predict.
    assert!(!prime_plan_file(
        dir.join("absent.md").to_str().unwrap(),
        "abc-123"
    ));

    // …and over a real one it writes exactly the sentinel the daemon's
    // `restore_handshake` recognises.
    let plan = dir.join("plan.md");
    std::fs::write(&plan, "# An old plan body\n").unwrap();
    assert!(prime_plan_file(plan.to_str().unwrap(), "abc-123"));
    let written = std::fs::read_to_string(&plan).unwrap();
    assert_eq!(restore_handshake(&written), Some(Some("abc-123".into())));

    let _ = std::fs::remove_dir_all(&dir);
}

/// Session ids are joined into a path, so anything that isn't the shape
/// Claude Code issues is refused before it can climb out of the projects
/// directory.
#[test]
fn session_ids_that_could_walk_the_filesystem_are_refused() {
    assert!(is_plain_session_id("4bf30a9f-3f6f-4e9d-8970-389c70869612"));
    assert!(is_plain_session_id("agent_a55a04f7bc248b80f"));
    assert!(!is_plain_session_id(""));
    assert!(!is_plain_session_id("../../etc/passwd"));
    assert!(!is_plain_session_id("a/b"));
    assert!(!is_plain_session_id("a.jsonl"));
    assert!(!is_plain_session_id(&"x".repeat(129)));
}

/// The transcript backfill: newest `message.model` wins, and a transcript
/// with no assistant turn yields `None` — never a guess.
#[test]
fn model_from_transcript_reads_the_newest_model_from_the_tail() {
    let dir = std::env::temp_dir().join(format!("rl-model-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.jsonl");
    std::fs::write(
        &path,
        concat!(
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-older-model\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-newest-model\"}}\n",
            "{\"type\":\"system\",\"subtype\":\"turn_end\"}\n",
        ),
    )
    .unwrap();
    assert_eq!(
        model_from_transcript(path.to_str().unwrap()).as_deref(),
        Some("claude-newest-model")
    );

    // A brand-new session: user turn only → None (the model lands one
    // hook fire late, once an assistant message exists).
    let fresh = dir.join("fresh.jsonl");
    std::fs::write(
        &fresh,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
    )
    .unwrap();
    assert_eq!(model_from_transcript(fresh.to_str().unwrap()), None);

    // Unreadable path → None, never an error path in the hook.
    assert_eq!(model_from_transcript("/nonexistent/nope.jsonl"), None);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The seat stamp + transcript backfill contract on the prompts table:
/// a seat-stamped row is never overwritten by the backfill, an unstamped
/// row is, and the drafter launch row binds to its session exactly once.
#[test]
fn model_backfill_and_drafter_bind_respect_capture_truth() {
    let db = Database::open_in_memory().unwrap();
    // A drafter-launched prompt: no claude session yet, no model.
    let body = "# plan body";
    let bh = ledger::body_hash(body);
    ledger::record_prompt(
        &db,
        ledger::PromptInput {
            source: ledger::PromptSource::DrafterLaunch,
            origin: ledger::Origin::Redline,
            surface: "drafter".into(),
            role: crate::ledger::CorpusRole::User,
            user_text: None,
            session_id: None,
            claude_session_id: None,
            mission_id: None,
            project_path: None,
            body: body.into(),
            thread: Some(ledger::ThreadRef {
                thread_kind: "drafter",
                thread_id: "draft-1".into(),
                parent_session_id: None,
            }),
            author: None,
            model: None,
            model_source: None,
        },
    )
    .unwrap();
    // A seat-stamped agent prompt under a live session.
    ledger::record_prompt(
        &db,
        ledger::PromptInput {
            source: ledger::PromptSource::RustFirstTurn,
            origin: ledger::Origin::Redline,
            surface: "browse".into(),
            role: crate::ledger::CorpusRole::User,
            user_text: None,
            session_id: None,
            claude_session_id: Some("cs-1".into()),
            mission_id: None,
            project_path: None,
            body: "discuss".into(),
            thread: None,
            author: None,
            model: Some("sonnet".into()),
            model_source: Some("seat".into()),
        },
    )
    .unwrap();

    // Bind the drafter row to its session (the ingest hook's claim moment).
    assert_eq!(db.bind_drafter_prompt_session(&bh, "draft-1", "cs-1").unwrap(), 1);
    // Re-binding matches nothing: claude_session_id is no longer NULL.
    assert_eq!(db.bind_drafter_prompt_session(&bh, "draft-1", "cs-2").unwrap(), 0);

    // The drafter row now lacks a model under cs-1 → backfill stamps it,
    // and the seat-stamped row keeps its capture-time truth.
    assert!(db.session_needs_model("cs-1"));
    assert_eq!(db.backfill_session_model("cs-1", "claude-from-transcript").unwrap(), 1);
    assert!(!db.session_needs_model("cs-1"), "everything stamped now");
    let models = db.list_prompt_models().unwrap();
    assert_eq!(models.len(), 2);
    assert!(models.iter().any(|(_, m)| m == "sonnet"));
    assert!(models.iter().any(|(_, m)| m == "claude-from-transcript"));
}

/// Cold-wallet posture pin: the daemon must bind loopback only, never a
/// routable interface. If someone changes this, they change the invariant.
#[test]
fn daemon_binds_loopback_only() {
    // The address the bind actually reads is the profile's, so that is
    // what the invariant has to be asserted on — a constant beside it
    // could stay loopback while the bind quietly did something else.
    assert_eq!(runtime_profile::PRODUCTION_ADDR, "127.0.0.1:7676");
    assert!(
        runtime_profile::current().daemon_addr().starts_with("127.0.0.1:"),
        "the daemon must bind loopback only (cold-wallet posture)"
    );
    // A candidate probe binds a different port — and it is still loopback.
    // The profile is what the bind actually reads, so the invariant has to
    // hold there too, not only on the constant.
    let probe = runtime_profile::resolve(
        &[
            (runtime_profile::ENV_PROFILE, "probe"),
            (runtime_profile::ENV_DATA_DIR, "/tmp/redline-probe"),
            (runtime_profile::ENV_PORT, "51234"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
    )
    .unwrap();
    assert!(probe.daemon_addr().starts_with("127.0.0.1:"));
    assert_ne!(probe.daemon_addr(), runtime_profile::PRODUCTION_ADDR);
}

#[test]
fn external_source_tags_are_fenced() {
    assert!(valid_source_tag("mylinter"));
    assert!(valid_source_tag("clippy-2"));
    assert!(valid_source_tag("a_b"));
    // Reserved authors and malformed tags are refused.
    assert!(!valid_source_tag("user"));
    assert!(!valid_source_tag("ai"));
    assert!(!valid_source_tag(""));
    assert!(!valid_source_tag("Has-Caps"));
    assert!(!valid_source_tag("space here"));
    assert!(!valid_source_tag(&"x".repeat(33)));
}
use crate::state::reparse_sections;
use std::sync::Arc;

// --- Browse-agent download helpers ------------------------------------

#[test]
fn pdf_and_non_http_tabs_are_exempt_from_suspension() {
    assert!(suspend_exempt_url("https://example.com/papers/A.PDF"));
    assert!(suspend_exempt_url("blob:https://example.com/2c9d"));
    assert!(suspend_exempt_url("data:application/pdf;base64,JVBERi0="));
    assert!(suspend_exempt_url("file:///Users/me/x.pdf"));
    assert!(!suspend_exempt_url("https://arxiv.org/abs/2401.00001"));
    assert!(!suspend_exempt_url("about:blank"));
    assert!(!suspend_exempt_url("not a url"));
}

#[test]
fn tab_start_loads_files_natively_and_refuses_other_schemes() {
    let (url, file) = browser_tab_start("https://example.com/a").unwrap();
    assert_eq!((url.as_str(), file), ("https://example.com/a", None));
    let (url, file) = browser_tab_start("file:///tmp/x%20y.pdf").unwrap();
    assert_eq!(url.as_str(), "about:blank");
    assert_eq!(file, Some(std::path::PathBuf::from("/tmp/x y.pdf")));
    assert!(browser_tab_start("about:blank").unwrap().1.is_none());
    assert!(browser_tab_start("blob:https://example.com/1").is_err());
    assert!(browser_tab_start("javascript:alert(1)").is_err());
}

#[test]
fn the_frontend_user_agent_is_pinned_to_the_native_one() {
    let ts = include_str!("../../src/lib/safariUA.ts");
    assert!(ts.contains(&format!("\"{SAFARI_UA}\"")), "src/lib/safariUA.ts drifted from SAFARI_UA");
}

#[test]
fn sanitize_basename_strips_traversal_and_separators() {
    // Path separators: only the final component survives — the security
    // boundary that keeps a fetched/derived name inside the target dir.
    assert_eq!(sanitize_basename("../../etc/passwd"), "passwd");
    assert_eq!(sanitize_basename("/abs/path/report.pdf"), "report.pdf");
    assert_eq!(sanitize_basename(r"C:\Users\x\evil.exe"), "evil.exe");
    // A lone `..` (or whitespace-only) is rejected so it can't name a dir.
    assert_eq!(sanitize_basename(".."), "");
    assert_eq!(sanitize_basename("   "), "");
    // Leading dots (dotfiles) and control chars are dropped.
    assert_eq!(sanitize_basename(".env"), "env");
    assert_eq!(sanitize_basename("a\u{0007}b.txt"), "ab.txt");
    // An ordinary name is untouched.
    assert_eq!(sanitize_basename("form20-f.htm"), "form20-f.htm");
}

#[test]
fn download_filename_from_url_path() {
    assert_eq!(
        download_filename("https://www.sec.gov/Archives/edgar/form20-f.htm", false),
        "form20-f.htm"
    );
    // Query and fragment are dropped before taking the basename.
    assert_eq!(
        download_filename("https://x.com/a/file.pdf?v=2#frag", false),
        "file.pdf"
    );
    // Trailing slash → the last real segment.
    assert_eq!(download_filename("https://x.com/docs/report/", false), "report");
    // DOM saves get an .html suffix unless they already end in .htm(l).
    assert_eq!(download_filename("https://example.com/page", true), "page.html");
    assert_eq!(download_filename("https://x.com/a.htm", true), "a.htm");
}

#[test]
fn host_of_extracts_bare_host() {
    assert_eq!(
        host_of("https://user:pass@www.sec.gov:443/path"),
        "www.sec.gov"
    );
    assert_eq!(host_of("http://example.com"), "example.com");
}

#[test]
fn content_disposition_filename_is_parsed_and_sanitized() {
    assert_eq!(
        filename_from_content_disposition("attachment; filename=\"report.pdf\""),
        Some("report.pdf".to_string())
    );
    assert_eq!(
        filename_from_content_disposition("inline; filename=plain.txt"),
        Some("plain.txt".to_string())
    );
    // A traversal attempt in the header is reduced to a bare basename.
    assert_eq!(
        filename_from_content_disposition("attachment; filename=\"../../x.sh\""),
        Some("x.sh".to_string())
    );
    // No filename param → None (the caller derives from the URL instead).
    assert_eq!(filename_from_content_disposition("attachment"), None);
}

#[test]
fn dedup_name_suffixes_only_on_collision() {
    // No collision → used as-is.
    assert_eq!(dedup_name("a.htm", |_| false), "a.htm");
    // The base name is taken → the suffix goes before the extension.
    assert_eq!(dedup_name("a.htm", |c| c == "a.htm"), "a (1).htm");
    // Base and (1) taken → (2).
    let taken = |c: &str| c == "a.htm" || c == "a (1).htm";
    assert_eq!(dedup_name("a.htm", taken), "a (2).htm");
    // Extensionless names get a bare " (1)" suffix.
    assert_eq!(dedup_name("README", |c| c == "README"), "README (1)");
}

fn make_store() -> SessionStore {
    let db = Arc::new(Database::open_in_memory().unwrap());
    SessionStore::new(db)
}

/// The combine reads: latest revision, caller's order, hard error on an
/// unknown id. A pill that silently vanished would change what was merged
/// without saying so.
#[test]
fn combine_rows_take_the_latest_revision_and_preserve_order() {
    let store = make_store();
    let v1 = "# Auth rework\n\nFirst pass.\n";
    let v2 = "# Auth rework\n\nSecond pass.\n";
    store.upsert_plan(
        "s1",
        "/tmp/a",
        v1.to_string(),
        reparse_sections(v1),
        true,
        false,
    );
    store.upsert_plan(
        "s1",
        "/tmp/a",
        v2.to_string(),
        reparse_sections(v2),
        false,
        false,
    );
    let b = "# Billing\n\nBody.\n";
    store.upsert_plan(
        "s2",
        "/tmp/b",
        b.to_string(),
        reparse_sections(b),
        true,
        false,
    );

    let rows = combine_rows(&store, &["s2".into(), "s1".into()]).unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["s2", "s1"],
        "the caller's order is the brief's order"
    );
    let auth = &rows[1];
    assert!(
        auth.raw_plan_markdown.contains("Second pass."),
        "latest revision only"
    );
    assert_eq!(auth.version_number, 2);
    assert_eq!(auth.status, "in_review");

    let err = combine_rows(&store, &["s1".into(), "nope".into()]).unwrap_err();
    assert!(
        err.contains("nope"),
        "an unknown id errors rather than being skipped: {err}"
    );
}

/// The bind must follow `row_hash` in BOTH arms. Only the threadless arm
/// is reachable from Combine today, so a drift here would be invisible
/// until the first combination launched from a thread — at which point it
/// would bind a hash no row has.
#[test]
fn both_ingest_bind_arms_follow_the_claim_row_hash() {
    // The handoff lives in `RedlineIngest::on_agent_prompt_skipped`
    // (polis_host.rs) since the capture route moved into polis-server;
    // the body hash arrives there as `bh: &str`.
    let body = include_str!("polis_host.rs");
    let at = body
        .find("let row_key = claim.row_hash.as_deref().unwrap_or(bh);")
        .expect("the ingest observer resolves a row key from the claim");
    // The window covers the whole `match claim.thread` block.
    let arms = &body[at..at + 900];
    assert!(
        arms.contains("db.bind_threaded_prompt_session(row_key,"),
        "the threaded arm still binds the guard key"
    );
    assert!(
        arms.contains("db.bind_launch_prompt_session(row_key,"),
        "the threadless arm still binds the guard key"
    );
    assert!(
        !arms.contains("bind_launch_prompt_session(bh") && !arms.contains("bind_launch_prompt_session(&bh"),
        "a stale bh bind is left in the ingest observer"
    );
}

/// `"combine"` must survive the origin filter, or every combination is
/// filed in the lake as a drafter launch — `surface` feeds `resolve_parent`
/// and the Companion's account of what you did.
#[test]
fn the_launch_origin_filter_accepts_combine() {
    let body = include_str!("lib.rs");
    let f = body
        .split_once("fn record_plan_launch(")
        .expect("record_plan_launch exists")
        .1;
    let filter = f.split_once("unwrap_or_else").expect("origin filter").0;
    for origin in ["front-door", "drafter", "browser", "browser-island", "chat", "combine", "front-door-run", "plan-handoff"] {
        assert!(
            filter.contains(&format!("\"{origin}\"")),
            "{origin} must be an accepted launch origin"
        );
    }
}

#[test]
fn export_name_uses_plan_title() {
    let title = parser::plan_title_from_markdown(
        "<!-- rl:blk-1 -->\n# Redline — Fixes & Improvements Pass\n\nbody",
    );
    assert_eq!(
        title.as_deref(),
        Some("Redline — Fixes & Improvements Pass")
    );
    assert_eq!(
        export_file_name(&title.unwrap(), 2, Some("20260608-234706"), "md"),
        "Redline-Fixes-Improvements-Pass-v2-20260608-234706.md"
    );
}

#[test]
fn export_name_falls_back_and_ignores_non_headings() {
    // A `#!`-style line or code `#` is not a heading.
    assert_eq!(parser::plan_title_from_markdown("#!/bin/bash\n#fff\ntext"), None);
    // No title → caller falls back to the project name.
    assert_eq!(
        export_file_name("my project", 1, None, "md"),
        "my-project-v1.md"
    );
    assert_eq!(
        export_file_name("my project", 1, None, "docx"),
        "my-project-v1.docx"
    );
}

#[test]
fn restore_target_id_parses_embedded_session_id() {
    // Id-bearing sentinel → the held plan's session id (resume forks the id,
    // or the command was pasted into a running REPL).
    assert_eq!(
        restore_target_id("<!-- rl:blk-1 -->\n<!-- REDLINE_RESTORE:36c1d078-abc -->"),
        Some("36c1d078-abc".to_string())
    );
    // Whitespace inside the marker is tolerated.
    assert_eq!(
        restore_target_id("<!-- REDLINE_RESTORE:  s-9  -->"),
        Some("s-9".to_string())
    );
    // Bare sentinel → no target (same-session, in-place restore).
    assert_eq!(restore_target_id("<!-- REDLINE_RESTORE -->"), None);
    // Empty id and non-restore bodies → no target.
    assert_eq!(restore_target_id("<!-- REDLINE_RESTORE: -->"), None);
    assert_eq!(restore_target_id("# A real plan\n\nbody"), None);
}

#[test]
fn restore_handshake_matches_only_sentinel_only_bodies() {
    // The handshake contract: the body IS the sentinel ("write exactly
    // `…` as your plan file's contents"). Both forms, whitespace-tolerant.
    assert_eq!(restore_handshake("<!-- REDLINE_RESTORE -->"), Some(None));
    assert_eq!(restore_handshake("  <!-- REDLINE_RESTORE -->\n"), Some(None));
    assert_eq!(
        restore_handshake("<!-- REDLINE_RESTORE:abc-123 -->"),
        Some(Some("abc-123".to_string()))
    );
    // Empty id degrades to the bare form, mirroring restore_target_id.
    assert_eq!(restore_handshake("<!-- REDLINE_RESTORE: -->"), Some(None));

    // A real plan that merely MENTIONS the sentinel — the bug this
    // anchoring exists to kill: a plan documenting the restore protocol
    // (quoting the sentinel in an evidence table) must be captured, not
    // classified as a handshake and waved through.
    assert_eq!(
        restore_handshake(
            "# Fix the restore path\n\nThe hook wrote `<!-- REDLINE_RESTORE -->` at 16:18:28.\n"
        ),
        None
    );
    assert_eq!(
        restore_handshake(
            "<!-- REDLINE_RESTORE:57b38664-9fa4-4b71-a5a2-fe88f70ac1b9 -->\n\n# Then a plan follows\n"
        ),
        None,
        "sentinel followed by real content is a plan, not a handshake"
    );
    // A different comment that shares the prefix is not the handshake.
    assert_eq!(restore_handshake("<!-- REDLINE_RESTOREX -->"), None);
    assert_eq!(restore_handshake("# A real plan\n\nbody"), None);
}

#[test]
fn rekey_gate_accepts_provider_ids_but_rejects_path_like_input() {
    assert!(valid_session_id("57b38664-9fa4-4b71-a5a2-fe88f70ac1b9"));
    assert!(valid_session_id("thr_0199a213-81c0-7800-8aa1-bbab2a035a53"));
    assert!(valid_session_id("ABC_123"));
    assert!(!valid_session_id("../../etc/passwd"));
    assert!(!valid_session_id("contains spaces"));
    assert!(!valid_session_id(""));
    assert!(!valid_session_id(&"a".repeat(129)));
}

#[test]
fn codex_plan_extraction_requires_one_complete_nonempty_block() {
    assert_eq!(
        extract_codex_proposed_plan("before\n<proposed_plan>\n# Build\n\nBody\n</proposed_plan>\nafter"),
        Some("# Build\n\nBody".to_string())
    );
    assert_eq!(extract_codex_proposed_plan("ordinary answer"), None);
    assert_eq!(extract_codex_proposed_plan("<proposed_plan> </proposed_plan>"), None);
    assert_eq!(extract_codex_proposed_plan("<proposed_plan># missing close"), None);
    assert_eq!(
        extract_codex_proposed_plan(
            "<proposed_plan># one</proposed_plan><proposed_plan># two</proposed_plan>"
        ),
        None
    );
}

#[test]
fn captured_plan_registers_pending_entry_with_terminal() {
    // 0d: the capture→hold→indicator seam, end to end (steps 1→3→4 with
    // the terminal resolver injected; step 2's lsof/ps walk has its own
    // coverage). A plan that merely MENTIONS the restore sentinel takes
    // the capture path — restore_handshake says "not a handshake" — and
    // the hold it registers exposes its terminal to the summaries the
    // InterceptStrip reads.
    let body =
        "# A plan about restores\n\nQuoting `<!-- REDLINE_RESTORE:57b38664-9fa4-4b71-a5a2-fe88f70ac1b9 -->` as evidence.\n";
    assert_eq!(
        restore_handshake(body),
        None,
        "must be captured, not passed through"
    );

    let store = make_store();
    let pending = PendingResponses::new();
    store.upsert_plan(
        "s1",
        "/tmp/d",
        body.to_string(),
        reparse_sections(body),
        true,
        false,
    );
    let (_rx, _token) = register_hold(&pending, "s1", Some("tab-a".to_string()));
    assert_eq!(pending.terminal_of("s1"), Some("tab-a".to_string()));

    let mut sessions = store.list();
    fold_pending_into_summaries(&mut sessions, &pending);
    let s = sessions
        .iter()
        .find(|s| s.session_id == "s1")
        .expect("summary");
    assert!(s.held, "captured plan must be held");
    assert_eq!(s.attach_state, AttachState::Held);
    assert_eq!(
        s.held_terminal_id.as_deref(),
        Some("tab-a"),
        "the strip's tab binding must survive the fold into summaries"
    );

    // A sentinel-only body is still a handshake (the restore path).
    assert!(restore_handshake("<!-- REDLINE_RESTORE -->").is_some());
}

#[test]
fn boot_routes_to_a_held_session_and_only_a_held_one() {
    // The one carve-out to "boot lands on the front door". The pick comes
    // from the same folded list the shell renders, so it can never name a
    // session the sidebar doesn't have.
    let store = make_store();
    let pending = PendingResponses::new();
    let md = "# Plan\n\nBody.\n";
    for id in ["idle-a", "held-b", "idle-c"] {
        store.upsert_plan(
            id,
            "/tmp/d",
            md.to_string(),
            reparse_sections(md),
            true,
            false,
        );
    }
    let mut sessions = store.list();
    fold_pending_into_summaries(&mut sessions, &pending);
    assert_eq!(
        held_session_id(&sessions),
        None,
        "nothing held: boot belongs to the front door"
    );

    // A live held POST is ground truth, even before the persisted state
    // catches up — which is exactly why the fold runs first.
    let (_rx, _token) = register_hold(&pending, "held-b", Some("tab-a".to_string()));
    let mut sessions = store.list();
    fold_pending_into_summaries(&mut sessions, &pending);
    let picked = held_session_id(&sessions).expect("held session claims the plate");
    assert_eq!(picked, "held-b");
    assert!(
        sessions.iter().any(|s| s.session_id == picked),
        "boot routed to a session that is not in the list it routes within"
    );
}

#[test]
fn register_hold_supersedes_a_stale_held_post() {
    // The orphan fix moved into register_hold: a second POST for the same
    // session releases the stale waiter cleanly, then takes over.
    let pending = PendingResponses::new();
    let (rx1, _t1) = register_hold(&pending, "s1", None);
    let (_rx2, _t2) = register_hold(&pending, "s1", Some("tab-b".to_string()));
    let stale = rx1.blocking_recv().expect("stale waiter must be answered");
    assert_eq!(stale.hook_specific_output.permission_decision, "allow");
    assert_eq!(pending.terminal_of("s1"), Some("tab-b".to_string()));
}

#[test]
fn delete_session_inner_refuses_held_without_force() {
    let store = make_store();
    let pending = PendingResponses::new();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan(
        "s1",
        "/tmp/d",
        md.to_string(),
        reparse_sections(md),
        true,
        false,
    );
    let _rx = pending.register("s1", None).expect("register first time");

    let err = delete_session_inner(&store, &pending, "s1", false)
        .expect_err("held session must be refused without force");
    assert!(err.contains("still active"), "got: {err}");
    assert!(
        pending.has("s1"),
        "held entry must survive a refused delete"
    );
    assert!(
        store.has_session("s1"),
        "store row must survive a refused delete"
    );
}

#[test]
fn delete_session_inner_force_drains_held_then_deletes() {
    let store = make_store();
    let pending = PendingResponses::new();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan(
        "s1",
        "/tmp/d",
        md.to_string(),
        reparse_sections(md),
        true,
        false,
    );
    let (rx, _token) = pending.register("s1", None).expect("register first time");

    let removed =
        delete_session_inner(&store, &pending, "s1", true).expect("force delete must succeed");
    assert!(removed, "delete must report true for an existing session");
    assert!(!pending.has("s1"), "held entry must be drained");
    assert!(!store.has_session("s1"), "store row must be gone");

    // The drained oneshot received a deny response so Claude Code's hook
    // returns cleanly rather than timing out.
    let resp = rx.blocking_recv().expect("oneshot must have been sent");
    assert_eq!(resp.hook_specific_output.permission_decision, "deny");
    assert!(
        resp.hook_specific_output
            .permission_decision_reason
            .contains("deleted"),
        "reason should mention deletion, got: {}",
        resp.hook_specific_output.permission_decision_reason
    );
}

/// A plan with one research comment (Search from the plan) and one plain
/// question on the same block.
fn research_fixture() -> (SessionStore, String, String) {
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
    let req = |v: serde_json::Value| serde_json::from_value::<crate::state::NewCommentRequest>(v).unwrap();
    let research = store
        .add_comment("s1", req(serde_json::json!({
            "type": "question", "anchorId": "A.1", "blockId": "blk-1", "body": "Search: rate limits",
            "research": { "query": "rate limits", "browseId": "b-7" }
        })))
        .expect("research comment");
    let plain = store
        .add_comment("s1", req(serde_json::json!({
            "type": "question", "anchorId": "A.1", "blockId": "blk-1", "body": "Why this order?"
        })))
        .expect("plain comment");
    (store, research.id, plain.id)
}

#[test]
fn a_research_comment_never_rides_a_revise_unless_promoted() {
    let (store, research_id, plain_id) = research_fixture();
    let (_, comments, _) = store.drafts_and_reopens_for_payload("s1").unwrap();
    let ids: Vec<&str> = comments.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec![plain_id.as_str()], "only the plain question rides");
    let submitted = store.mark_submitted("s1");
    assert_eq!(submitted, vec![plain_id.clone()]);
    // Promoting it ("Make this a change") is what lets it ride.
    store.unmark_submitted("s1", &submitted);
    store
        .attach_discussion("s1", &research_id, Some("Use 100/min."), true)
        .expect("promote");
    let (_, comments, _) = store.drafts_and_reopens_for_payload("s1").unwrap();
    assert!(comments.iter().any(|c| c.id == research_id));
}

#[test]
fn the_first_tab_answer_links_bounded_and_a_later_turn_does_not_relink() {
    let (store, research_id, _) = research_fixture();
    let long = "é".repeat(5000); // 10 KB, multi-byte
    assert_eq!(store.link_research_answer("b-7", &long), vec!["s1".to_string()]);
    assert!(store.link_research_answer("b-other", "x").is_empty());
    let get = || {
        store.get("s1").unwrap().revisions.iter().flat_map(|r| r.comments.clone())
            .find(|c| c.id == research_id).unwrap().research.unwrap()
    };
    let link = get();
    assert_eq!(link.answer_hash.as_deref(), Some(ledger::body_hash(&long).as_str()));
    let excerpt = link.answer_excerpt.unwrap();
    assert!(excerpt.len() <= crate::state::RESEARCH_EXCERPT_MAX && excerpt.chars().all(|c| c == 'é'));
    // A follow-up in the tab is not the result.
    assert!(store.link_research_answer("b-7", "a later turn").is_empty());
    assert_eq!(get().answer_hash.as_deref(), Some(ledger::body_hash(&long).as_str()));
    // And it survives a reload from the DB.
    let reloaded = SessionStore::new(store.database());
    let persisted = reloaded.get("s1").unwrap().revisions.iter().flat_map(|r| r.comments.clone())
        .find(|c| c.id == research_id).unwrap().research.unwrap();
    assert_eq!(persisted.answer_hash, get().answer_hash);
    assert_eq!(persisted.browse_id, "b-7");
}

#[test]
fn approve_plan_later_inner_approves_stands_down_and_leaves_run_state_null() {
    let store = make_store();
    let pending = PendingResponses::new();
    let expected_modes = ExpectedModes::new();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
    let (rx, _token) = pending.register("s1", None).expect("register");
    expected_modes.set("s1", SubmissionMode::Ask);

    approve_plan_later_inner(&store, &pending, &expected_modes, "s1")
        .expect("approve-later with a held sender must succeed");

    let resp = rx.blocking_recv().expect("oneshot must have been sent");
    assert_eq!(resp.hook_specific_output.permission_decision, "deny");
    assert_eq!(resp.hook_specific_output.permission_decision_reason, BUILD_LATER_STAND_DOWN);
    let session = store.get("s1").expect("session exists");
    assert_eq!(session.status, SessionStatus::Approved);
    assert_eq!(session.attach_state, AttachState::Idle);
    // NULL run_state IS "approved · not built" — and the queue sees it.
    assert_eq!(store.database().get_run_state("s1"), None);
    assert!(expected_modes.take("s1").is_none());
    assert!(pending.take("s1").is_none());
    // The approval is a ledger decision, exactly like a plain Approve.
    assert!(store.database().latest_decision_seq("s1", "approval").unwrap().is_some());
}

#[test]
fn approve_plan_later_errs_without_held_sender_and_stand_down_is_calm() {
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
    assert!(approve_plan_later_inner(&store, &PendingResponses::new(), &ExpectedModes::new(), "s1").is_err());
    assert_eq!(store.get("s1").unwrap().status, SessionStatus::InReview);
    assert!(BUILD_LATER_STAND_DOWN.starts_with("✅"));
    for needle in ["Do NOT implement", "do not call ExitPlanMode", "from Redline"] {
        assert!(BUILD_LATER_STAND_DOWN.contains(needle), "{needle}");
    }
}

#[test]
fn mark_plan_build_requires_an_approved_plan_and_a_known_mode() {
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
    assert!(mark_plan_build_inner(&store, "s1", "codex", "same").is_err(), "in review");
    store.set_status("s1", SessionStatus::Approved);
    assert!(mark_plan_build_inner(&store, "s1", "codex", "bogus").is_err());
    mark_plan_build_inner(&store, "s1", "codex", "handoff").expect("approved plan builds");
}

#[test]
fn store_run_state_transitions_update_memory_and_db() {
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan(
        "s1",
        "/tmp/d",
        md.to_string(),
        reparse_sections(md),
        true,
        false,
    );

    assert!(store.set_run_state("s1", "building"));
    assert!(
        !store.set_run_state("s1", "building"),
        "same value → no transition (no event, no journal)"
    );
    assert!(store.set_run_state("s1", "landed"));
    // Both the in-memory summary (the chip's source) and the DB agree.
    let summary = store.list().into_iter().find(|s| s.session_id == "s1").unwrap();
    assert_eq!(summary.run_state.as_deref(), Some("landed"));
    assert_eq!(store.database().get_run_state("s1").as_deref(), Some("landed"));
    // Unknown session: quietly false.
    assert!(!store.set_run_state("ghost", "building"));
    // One journal line per REAL transition.
    let journal = store.database().list_journal_since(0, 100).unwrap();
    let n = journal.iter().filter(|r| r.kind == "run_state").count();
    assert_eq!(n, 2);
}

#[test]
fn clear_run_state_nulls_columns_and_journals() {
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan(
        "s1",
        "/tmp/d",
        md.to_string(),
        reparse_sections(md),
        true,
        false,
    );
    let db = store.database();

    assert!(store.set_run_state("s1", "building"));
    assert_eq!(db.get_run_state("s1").as_deref(), Some("building"));

    assert!(store.clear_run_state("s1"), "a set state must clear");
    assert_eq!(db.get_run_state("s1"), None, "run_state back to NULL");
    assert!(!store.clear_run_state("s1"), "clearing NULL is a no-op");
    // The in-memory mirror follows the DB.
    assert!(store.get("s1").unwrap().run_state.is_none());
    // Journalled as `run_state: cleared` so the Companion feed sees it.
    let journal = db.list_journal_since(0, 100).unwrap();
    assert!(
        journal.iter().any(|e| e.kind == "run_state" && e.label.as_deref() == Some("cleared")),
        "clear must journal"
    );
    // `set_run_state` after a clear works normally (NULL → value).
    assert!(store.set_run_state("s1", "building"));
    assert_eq!(db.get_run_state("s1").as_deref(), Some("building"));
}

#[test]
fn manual_plan_state_records_completion_reopen_and_refuses_a_held_plan() {
    let store = make_store(); let pending = PendingResponses::new();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("manual", "/tmp/d", md.into(), reparse_sections(md), true, false);
    set_plan_state_inner(&store, &pending, "manual", "approved").unwrap();
    let approved = store.get("manual").unwrap();
    assert_eq!(approved.status, SessionStatus::Approved);
    assert_eq!(approved.run_state, None);
    assert_eq!(approved.attach_state, AttachState::Idle);
    let approval = store.database().latest_approval_seq("manual").unwrap();
    set_plan_state_inner(&store, &pending, "manual", "completed").unwrap();
    assert_eq!(store.get("manual").unwrap().run_state.as_deref(), Some("landed"));
    set_plan_state_inner(&store, &pending, "manual", "in_review").unwrap();
    let reopened = store.get("manual").unwrap();
    assert_eq!(reopened.status, SessionStatus::InReview);
    assert_eq!(reopened.attach_state, AttachState::Detached);
    assert_eq!(reopened.run_state, None);
    assert!(store.database().supersessions_for_seqs(&[approval]).unwrap().contains_key(&approval));
    let (_rx, _token) = pending.register("manual", None).unwrap();
    assert!(set_plan_state_inner(&store, &pending, "manual", "completed").unwrap_err().contains("waiting"));
    pending.take("manual");
}

#[test]
fn moved_project_survives_upsert_and_moves_origin_work() {
    let store = make_store(); let md = "# Plan\n\nBody.\n";
    store.upsert_plan("moved", "/old", md.into(), reparse_sections(md), true, false);
    store.set_status("moved", SessionStatus::Approved);
    store.database().insert_work_item(&crate::work::WorkItem {
        id: "move-work".into(), title: "Linked work".into(), body: None,
        status: "open".into(), priority: 2, kind: "task".into(), assignee: None,
        claimed_at: None, lease_expires_at: None, closed_at: None, close_reason: None,
        defer_until: None, origin_kind: Some("session".into()), origin_id: Some("moved".into()),
        project_path: Some("/old".into()), pinned: false, created_at: 1, updated_at: 1,
    }).unwrap();
    let dir = std::env::temp_dir().join(format!("redline-move-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    set_session_project_inner(&store, "moved", dir.to_str().unwrap()).unwrap();
    let path = std::fs::canonicalize(&dir).unwrap().to_string_lossy().into_owned();
    let moved = store.get("moved").unwrap();
    assert_eq!(moved.project_path, path);
    assert_eq!(store.database().get_work_item("move-work").unwrap().project_path.as_deref(), Some(path.as_str()));
    store.database().upsert_session(&moved).unwrap();
    assert_eq!(store.database().load_session("moved").unwrap().unwrap().project_path, path);
    assert!(set_session_project_inner(&store, "moved", "/does-not-exist/redline").is_err());
    assert_eq!(resume_cwd_for("nonexistent-test-session", Some(path.clone()), Some("claude-code")), Some(path));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unapprove_plan_supersedes_the_approval_and_keeps_the_chain_intact() {
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan(
        "s1",
        "/tmp/d",
        md.to_string(),
        reparse_sections(md),
        true,
        false,
    );
    let db = store.database();

    // Not approved yet → refused.
    assert!(unapprove_plan_inner(&store, "s1").is_err());

    store.set_status("s1", SessionStatus::Approved);
    let approval_seq = db
        .latest_approval_seq("s1")
        .expect("approval event recorded");

    unapprove_plan_inner(&store, "s1").expect("un-approve an approved session");
    let s = store.get("s1").unwrap();
    assert_eq!(s.status, SessionStatus::InReview);
    assert_eq!(s.attach_state, AttachState::Detached, "never fake Held");

    // The reversal is a supersession, never a delete: the approval event
    // is still in the chain, now superseded by the reopen decision.
    let map = db.supersessions_for_seqs(&[approval_seq]).unwrap();
    let new_seq = *map.get(&approval_seq).expect("approval must be superseded");
    assert!(new_seq > approval_seq);
    let verdict = db.verify_ledger_chain().unwrap();
    assert!(
        verdict.ok,
        "the hash chain must still verify after the rescission (first bad: {:?})",
        verdict.first_bad_seq
    );

    // Double un-approve: no longer approved → refused, and nothing broke.
    assert!(unapprove_plan_inner(&store, "s1").is_err());
}

#[tokio::test]
async fn take_or_wait_returns_immediately_when_sender_present() {
    let pending = PendingResponses::new();
    let _rx = pending.register("s1", None).expect("first register");

    let tx = pending
        .take_or_wait("s1", Duration::from_secs(5))
        .await
        .expect("sender was already registered");
    // The senderslot must be drained — a second take returns None.
    assert!(pending.take("s1").is_none(), "take must remove the slot");
    // Sending into the channel still works (no double-take).
    let _ = tx.send(allow_response("ok"));
}

#[tokio::test]
async fn take_or_wait_waits_for_late_register() {
    // The bug-5 race: take_or_wait fires before the next plan's POST
    // registers its sender. The take must wake up when register() runs
    // and return the freshly-registered sender, not bail out.
    let pending = PendingResponses::new();
    let waiter = {
        let pending = pending.clone();
        tokio::spawn(async move {
            pending
                .take_or_wait("s2", Duration::from_secs(2))
                .await
                .map(|_| ())
        })
    };
    // Yield long enough that the waiter is parked on `notified()`.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _rx = pending.register("s2", None).expect("late register");
    let got = waiter.await.expect("waiter task panicked");
    assert!(got.is_some(), "take_or_wait must wake on register");
}

#[tokio::test]
async fn take_or_wait_times_out_when_no_sender_ever_arrives() {
    let pending = PendingResponses::new();
    let out = pending
        .take_or_wait("nobody", Duration::from_millis(50))
        .await;
    assert!(out.is_none(), "take_or_wait must time out cleanly");
}

#[test]
fn revise_watch_generation_detects_supersession() {
    let watch = ReviseWatch::new();
    // No revise yet → generation reads 0.
    assert_eq!(watch.current("s1"), 0);

    // First revise: a watchdog armed under gen 1 still owns the wait.
    let armed_first = watch.bump("s1");
    assert_eq!(armed_first, 1);
    assert_eq!(watch.current("s1"), armed_first);

    // A second revise bumps the generation; the first watchdog must now see
    // itself superseded and bail, while the second one owns the wait.
    let armed_second = watch.bump("s1");
    assert_eq!(armed_second, 2);
    assert_ne!(watch.current("s1"), armed_first);
    assert_eq!(watch.current("s1"), armed_second);

    // Counters are per-session — an unrelated session is unaffected.
    assert_eq!(watch.current("s2"), 0);
    assert_eq!(watch.bump("s2"), 1);
    assert_eq!(watch.current("s1"), 2);
}

#[test]
fn last_claude_pid_set_get_clear() {
    let map = LastClaudePid::default();
    assert!(map.get("s1").is_none(), "absent session reads None");

    map.set(
        "s1",
        ClaudeProc {
            pid: 1234,
            comm: "claude".into(),
        },
    );
    let got = map.get("s1").expect("present after set");
    assert_eq!(got.pid, 1234);
    assert_eq!(got.comm, "claude");

    // Overwrite replaces the prior record (refreshed on every POST).
    map.set(
        "s1",
        ClaudeProc {
            pid: 5678,
            comm: "node".into(),
        },
    );
    assert_eq!(map.get("s1").unwrap().pid, 5678);

    map.clear("s1");
    assert!(map.get("s1").is_none(), "cleared session reads None");
}

#[test]
fn claude_proc_is_alive_guards_pid_reuse() {
    let proc = ClaudeProc {
        pid: 4242,
        comm: "claude".into(),
    };
    // Same pid, same command → alive.
    assert!(proc.is_alive_with(|_| Some("claude".to_string())));
    // No such process → dead.
    assert!(!proc.is_alive_with(|_| None));
    // Pid reused by a different command → dead (must not read as alive).
    assert!(!proc.is_alive_with(|_| Some("zsh".to_string())));
}

#[cfg(unix)]
#[test]
fn current_comm_reflects_process_liveness() {
    // Our own pid is obviously alive and names a non-empty command.
    let mine = current_comm(std::process::id());
    assert!(mine.is_some_and(|c| !c.is_empty()), "self must be alive");

    // A child we spawn and reap is dead by the time we probe its pid.
    let mut child = std::process::Command::new("true")
        .spawn()
        .expect("spawn `true`");
    let dead_pid = child.id();
    child.wait().expect("reap child");
    assert!(
        current_comm(dead_pid).is_none(),
        "a reaped process must read as dead"
    );
}

#[test]
fn watchdog_step_decision_table() {
    // Any "already settled" signal stops the watchdog regardless of liveness.
    assert_eq!(
        watchdog_step(true, true, true, Some(true)),
        WatchdogStep::Stop,
        "a fresh plan landed → stop"
    );
    assert_eq!(
        watchdog_step(false, false, true, Some(true)),
        WatchdogStep::Stop,
        "a newer revise superseded us → stop"
    );
    assert_eq!(
        watchdog_step(false, true, false, Some(true)),
        WatchdogStep::Stop,
        "no longer in review → stop"
    );
    // Still waiting + claude alive → re-arm (the false-positive we fix).
    assert_eq!(
        watchdog_step(false, true, true, Some(true)),
        WatchdogStep::ReArm,
        "alive claude (busy/blocked) → keep watching, never detach"
    );
    // Still waiting + claude dead → detach.
    assert_eq!(
        watchdog_step(false, true, true, Some(false)),
        WatchdogStep::Detach,
        "dead claude → feedback lost, detach"
    );
    // Still waiting + pid never captured → fall back to blind-timer detach.
    assert_eq!(
        watchdog_step(false, true, true, None),
        WatchdogStep::Detach,
        "no pid → preserve today's behavior, detach"
    );
}

#[test]
fn agent_exit_detaches_only_a_live_review_whose_agent_is_gone() {
    // A revising plan (in review, holding no POST) whose agent's PTY exited.
    assert!(agent_exit_detaches(true, false, false, Some(false)), "dead → detach now");
    assert!(agent_exit_detaches(true, false, false, None), "no pid captured → trust the exit");
    // The liveness gate: a claude still alive was not in that PTY.
    assert!(!agent_exit_detaches(true, false, false, Some(true)), "alive → never declared dead");
    // A held POST's own drop-guard reports it when the connection closes.
    assert!(!agent_exit_detaches(true, false, true, None), "held → the drop-guard's job");
    // Already detached, or no longer in review: nothing to reconcile.
    assert!(!agent_exit_detaches(true, true, false, None), "already detached");
    assert!(!agent_exit_detaches(false, false, false, Some(false)), "approved / closed");
}

#[test]
fn take_if_owned_only_removes_matching_token() {
    let pending = PendingResponses::new();
    let (_rx1, token1) = pending.register("s1", None).expect("first register");

    // Supersede: take the original and register a fresh one (new token).
    let _ = pending.take("s1").expect("take original");
    let (_rx2, token2) = pending.register("s1", None).expect("re-register");
    assert_ne!(token1, token2, "tokens must be unique per registration");

    // The stale guard (token1) must NOT clobber the new registration.
    assert!(
        pending.take_if_owned("s1", token1).is_none(),
        "stale token must not remove a superseding entry"
    );
    assert!(pending.has("s1"), "the live entry must survive");

    // The owning guard (token2) reclaims its own orphaned sender.
    assert!(
        pending.take_if_owned("s1", token2).is_some(),
        "matching token must remove its own entry"
    );
    assert!(!pending.has("s1"), "entry gone after owned take");
}

#[test]
fn terminal_binding_lives_and_dies_with_the_held_entry() {
    // The per-terminal "plan intercepted" strip reads terminal_of(); the
    // binding must exist exactly while the POST is held — once the entry
    // is taken (decision / supersede / detach), no tab may keep the strip.
    let pending = PendingResponses::new();
    let (_rx, _token) = pending
        .register("s1", Some("tab-a".to_string()))
        .expect("register");
    assert_eq!(pending.terminal_of("s1"), Some("tab-a".to_string()));
    assert_eq!(
        pending.terminal_of("s2"),
        None,
        "unheld session has no binding"
    );

    let _ = pending.take("s1").expect("take");
    assert_eq!(
        pending.terminal_of("s1"),
        None,
        "binding must vanish with the held entry"
    );

    // External-terminal intercepts hold with no binding at all.
    let (_rx2, _) = pending.register("s1", None).expect("re-register");
    assert_eq!(pending.terminal_of("s1"), None);
}

#[test]
fn send_into_dropped_receiver_is_an_error() {
    // Models the timed-out / detached held POST: submit_review must detect
    // this and roll back rather than report a false success.
    let pending = PendingResponses::new();
    let (rx, _token) = pending.register("s1", None).expect("register");
    drop(rx); // receiver gone — the held POST ended
    let tx = pending.take("s1").expect("sender still in map");
    assert!(
        tx.send(allow_response("late")).is_err(),
        "sending into a dropped receiver must fail"
    );
}

#[test]
fn drain_all_returns_session_ids_with_senders() {
    // apply_mode settles each drained session's attach state, so the
    // drain must say *which* sessions it released.
    let pending = PendingResponses::new();
    let (_rx1, _) = pending.register("s1", None).expect("register s1");
    let (_rx2, _) = pending.register("s2", None).expect("register s2");
    let mut drained: Vec<String> = pending
        .drain_all()
        .into_iter()
        .map(|(sid, _tx)| sid)
        .collect();
    drained.sort();
    assert_eq!(drained, vec!["s1".to_string(), "s2".to_string()]);
    assert!(!pending.has("s1"));
    assert!(!pending.has("s2"));
}

#[test]
fn inbound_plan_resets_stale_approved_status() {
    // The same-terminal-session repro: a thread is reviewed and approved,
    // then a fresh plan reuses the session. Without the status reset the
    // session stays `approved` forever and the frontend's
    // `status !== "approved"` gate disables the Approve button for every
    // later thread.
    use crate::state::{CommentKind, SessionStatus};
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan(
        "s1",
        "/tmp/d",
        md.to_string(),
        reparse_sections(md),
        true,
        false,
    );
    // A submitted comment from the approved thread must not leak into the
    // next plan's classification once the session is approved.
    store
        .add_comment(
            "s1",
            NewCommentRequest {
                id: None,
                kind: CommentKind::Feedback,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: Some("rl:blk-1".to_string()),
                structural: None,
                body: "tighten this".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .unwrap();
    store.mark_submitted("s1");
    store.set_status("s1", SessionStatus::Approved);

    // Classification reads the OLD status: an approved session has no
    // outstanding review, so the next plan starts a fresh thread.
    assert!(
        !store.has_outstanding_review("s1"),
        "approved session must classify the next plan as thread_start"
    );

    // The fresh plan arrives — upsert alone must not touch status...
    store.upsert_plan(
        "s1",
        "/tmp/d",
        md.to_string(),
        reparse_sections(md),
        true,
        false,
    );
    assert_eq!(store.get("s1").unwrap().status, SessionStatus::Approved);
    // ...the settle step (what handle_plan runs before emitting) does.
    settle_inbound_plan_state(&store, "s1");

    let s = store.get("s1").expect("session");
    assert_eq!(s.status, SessionStatus::InReview);
    assert_eq!(s.attach_state, AttachState::Held);
}

#[test]
fn delete_session_inner_non_held_path_unchanged() {
    let store = make_store();
    let pending = PendingResponses::new();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan(
        "s1",
        "/tmp/d",
        md.to_string(),
        reparse_sections(md),
        true,
        false,
    );

    // No POST held → both force values behave identically.
    let removed = delete_session_inner(&store, &pending, "s1", false)
        .expect("non-held delete must succeed");
    assert!(removed);
    assert!(!store.has_session("s1"));
}

// --- Layer 1: out-of-band feedback delivery -------------------------------

#[test]
fn pending_feedback_set_get_clear_roundtrip() {
    let pf = PendingFeedback::new();
    assert!(pf.get("s1").is_none(), "empty store has nothing pending");
    pf.set("s1", "FULL PAYLOAD".to_string());
    // Idempotent: a duplicate/late curl re-reads the same bytes.
    assert_eq!(pf.get("s1").as_deref(), Some("FULL PAYLOAD"));
    assert_eq!(pf.get("s1").as_deref(), Some("FULL PAYLOAD"));
    // A second submit overwrites, never appends.
    pf.set("s1", "NEWER".to_string());
    assert_eq!(pf.get("s1").as_deref(), Some("NEWER"));
    // Sessions are isolated.
    assert!(pf.get("s2").is_none());
    pf.clear("s1");
    assert!(pf.get("s1").is_none(), "clear (rollback path) removes it");
}

/// A stand-in for a real review payload — the bytes the golden suites pin.
const PAYLOAD: &str = "FEEDBACK:\n[edit, local] c-001\n\nCURRENT PLAN\n# Plan\n";

#[test]
fn feedback_deny_reason_is_calm_one_liner_with_fetch_url() {
    let revise = feedback_deny_reason(SubmissionMode::Revise, "abc-123", "claude-code", PAYLOAD);
    // The defusing words lead so the unavoidable `Error:` prefix reads benign.
    assert!(revise.starts_with("✅ Plan returned to Redline for revision"));
    assert!(revise.contains("nothing"), "must reassure nothing failed");
    // Points at the out-of-band channel with the real session id.
    assert!(revise.contains(
        "curl -s http://127.0.0.1:7676/v1/sessions/abc-123/feedback"
    ));
    // Single logical line — no bulky body inlined (that's the whole point).
    assert!(!revise.contains("FEEDBACK:"));
    assert!(!revise.contains("CURRENT PLAN"));
    assert!(!revise.contains('\n'), "reason must be one line, got: {revise}");
    // Both arms name the skill — the deny reason is one of the two places
    // the plan session ever hears the contract exists.
    assert!(revise.contains("redline-plan-review"));

    let ask = feedback_deny_reason(SubmissionMode::Ask, "abc-123", "claude-code", PAYLOAD);
    // Ask keeps its load-bearing "do not change the plan body" contract.
    assert!(ask.contains("NOT"));
    assert!(ask.contains("unchanged"));
    assert!(ask.contains(
        "curl -s http://127.0.0.1:7676/v1/sessions/abc-123/feedback"
    ));
    assert!(!ask.contains('\n'), "reason must be one line, got: {ask}");
    assert!(ask.contains("redline-plan-review"));
}

#[test]
fn the_codex_deny_reason_inlines_the_review_it_could_never_fetch() {
    // A codex plan session runs under `-s read-only`; a command the model
    // runs in that sandbox cannot reach 127.0.0.1 at all. Handing it a URL
    // would stall the round-trip with the feedback sitting one hop away.
    for mode in [SubmissionMode::Revise, SubmissionMode::Ask] {
        let reason = feedback_deny_reason(mode, "abc-123", "codex", PAYLOAD);
        assert!(reason.starts_with("✅"), "must still lead defusing");
        assert!(!reason.contains("curl"), "got: {reason}");
        assert!(!reason.contains("127.0.0.1"), "got: {reason}");
        // The payload itself, byte-for-byte, is the delivery.
        assert!(reason.ends_with(PAYLOAD), "got: {reason}");
        // …and it must name the submission shape codex actually has.
        assert!(reason.contains("<proposed_plan>"), "got: {reason}");
        assert!(!reason.contains("ExitPlanMode"), "got: {reason}");
    }
    let revise = feedback_deny_reason(SubmissionMode::Revise, "abc-123", "codex", PAYLOAD);
    // The two halves whose absence is silent.
    assert!(revise.contains("rl:blk-"));
    assert!(revise.contains("REDLINE_RESOLUTIONS"));
    // Ask keeps its load-bearing "do not change the plan body" contract.
    let ask = feedback_deny_reason(SubmissionMode::Ask, "abc-123", "codex", PAYLOAD);
    assert!(ask.contains("NOT"));
    assert!(ask.contains("unchanged"));
}

#[test]
fn the_claude_deny_reason_still_inlines_nothing() {
    // The whole point of the out-of-band channel: a wall of text in an
    // `Error:` box is the failure this replaced.
    for mode in [SubmissionMode::Revise, SubmissionMode::Ask] {
        let reason = feedback_deny_reason(mode, "abc-123", "claude-code", PAYLOAD);
        assert!(!reason.contains("CURRENT PLAN"), "got: {reason}");
        assert!(!reason.contains("FEEDBACK:"), "got: {reason}");
    }
}

#[test]
fn codex_stop_gates_on_the_block_not_the_mode() {
    // A Redline-launched codex runs in `default` mode with the contract
    // injected — no CLI flag starts the TUI in native Plan Mode — so a
    // permission_mode gate would reject every plan this app launches.
    let one = "here you go\n<proposed_plan>\n# Plan\n\nBody.\n</proposed_plan>";
    assert_eq!(
        extract_codex_proposed_plan(one).as_deref(),
        Some("# Plan\n\nBody.")
    );
    // …while the strictness that makes the relaxed gate safe still holds.
    assert!(extract_codex_proposed_plan("no block here").is_none());
    assert!(
        extract_codex_proposed_plan("I will emit a <proposed_plan> block soon").is_none(),
        "prose that merely names the marker must never be captured"
    );
    assert!(
        extract_codex_proposed_plan(
            "<proposed_plan>a</proposed_plan><proposed_plan>b</proposed_plan>"
        )
        .is_none(),
        "two blocks are ambiguous, not a plan"
    );
    assert!(extract_codex_proposed_plan("<proposed_plan>   </proposed_plan>").is_none());
}

#[test]
fn codex_approval_finishes_the_planning_turn_and_revision_continues_it() {
    // Implementation is queued separately before approval releases Stop.
    // Returning block here would re-enter the read-only planning turn.
    for reason in ["approved", "paused", "superseded", "fork ignored"] {
        assert_eq!(codex_stop_response(allow_response(reason)), json!({}));
    }
    let revision = codex_stop_response(deny_response("revise this plan"));
    assert_eq!(revision, json!({"decision":"block","reason":"revise this plan"}));
    let stand_down = codex_stop_response(deny_response(BUILD_LATER_STAND_DOWN));
    assert!(!stand_down["reason"].as_str().unwrap().contains("Begin implementing"));
    let claude = serde_json::to_value(allow_response("approved")).unwrap();
    assert_eq!(claude.as_object().unwrap().len(), 1);
    assert_eq!(claude["hookSpecificOutput"]["permissionDecision"], "allow");
}

// --- T4.2: landing a plan closes the work it opened ---------------------

/// `work_items` carried 595 rows and had never closed one — every close
/// path existed, none was reached from a transition. Landing is the
/// transition that means "done"; nothing else is.
#[test]
fn landing_a_plan_closes_its_sessions_open_items() {
    use crate::work::WorkItem;
    let db = Database::open_in_memory().unwrap();
    let item = |id: &str, origin_kind: &str, origin_id: &str, status: &str| WorkItem {
        id: id.to_string(),
        title: format!("item {id}"),
        body: None,
        status: status.to_string(),
        priority: 2,
        kind: "task".to_string(),
        assignee: None,
        claimed_at: None,
        lease_expires_at: None,
        closed_at: None,
        close_reason: None,
        defer_until: None,
        origin_kind: Some(origin_kind.to_string()),
        origin_id: Some(origin_id.to_string()),
        project_path: Some("/repo".to_string()),
        pinned: false,
        created_at: 1,
        updated_at: 1,
    };
    // Two open items this session opened…
    db.insert_work_item(&item("w-1", "session", "s1", "open"))
        .unwrap();
    db.insert_work_item(&item("w-2", "session", "s1", "open"))
        .unwrap();
    // …one already closed (must not be re-stamped)…
    db.insert_work_item(&item("w-3", "session", "s1", "closed"))
        .unwrap();
    // …an item filed from somewhere else about this plan…
    db.insert_work_item(&item("w-4", "plan_run", "s1", "open"))
        .unwrap();
    // …and another session's work.
    db.insert_work_item(&item("w-5", "session", "s2", "open"))
        .unwrap();

    // Only `landed` retires work.
    assert!(run_state_closes_work("landed"));
    for s in ["building", "approved"] {
        assert!(!run_state_closes_work(s), "{s} must not close work");
    }

    let mut moved = close_run_work_items(&db, "s1");
    moved.sort();
    assert_eq!(moved, vec!["w-1".to_string(), "w-2".to_string()]);

    let status = |id: &str| db.get_work_item(id).expect("row").status;
    assert_eq!(status("w-1"), "closed");
    assert_eq!(status("w-2"), "closed");
    assert_eq!(
        db.get_work_item("w-1").unwrap().close_reason.as_deref(),
        Some("landed"),
        "the reason names the transition that closed it"
    );
    assert_eq!(
        status("w-4"),
        "open",
        "only items whose origin IS the session close"
    );
    assert_eq!(status("w-5"), "open", "another session's work is untouched");

    // The already-closed row keeps its original stamp.
    assert_eq!(db.get_work_item("w-3").unwrap().close_reason, None);

    // Idempotent: landing twice moves nothing the second time.
    assert!(close_run_work_items(&db, "s1").is_empty());
}

