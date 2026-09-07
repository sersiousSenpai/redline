// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Intake triage — the bridge from the work graph's raw requests to the
//! Prompt Drafter. `POST /v1/work` is the intake itself (any filer can land a
//! raw request as an open item); this module is the ON-DEMAND triage pass
//! that turns such an item into a plan-prompt document the human redlines in
//! the Drafter and launches through the existing plan flow. The human reviews
//! INTENT up front — the machine never lands anything.
//!
//! Boundaries, deliberately:
//! - `work.rs` stays a pure state plane (its guard test forbids it naming
//!   the spawn chokepoint); the execution-shaped act lives HERE and talks to
//!   the work graph only through `db` reads/writes.
//! - The triage pass is drafter-shaped work, so it runs on the existing
//!   `drafter` seat — no new seat, and `bridge_args` keeps its tool surface
//!   the canonical read-only headless block (no `Edit`/`Write`, permission
//!   mode `default`). `read_only_guard` additionally refuses a spawn if the
//!   seat's user-configured extra flags try to smuggle `acceptEdits` in.
//! - ON-DEMAND ONLY: one tauri command, no watcher, no polling, no
//!   auto-spawn. A bus watch may target this role in a later wave.
//!
//! The triage output lands exactly the way the Shipwright lands documents:
//! `upsert_draft(.., doc_json = None)` with the markdown as the mirror. That
//! null-body-plus-mirror row IS the house shape for agent-landed documents —
//! the Drafter builds the TipTap body from `docMarkdown` on first open
//! (`App.tsx`'s load path handles it by construction), so writing TipTap JSON
//! from Rust would only duplicate the frontend parser and risk shape drift.
//!
//! Durable linkage — child message, not a body edit: the draft is recorded on
//! the work item as a CHILD item (`<parent>.N`, kind `message`, filed `held`)
//! carrying `origin_kind="drafter"` / `origin_id=<draft_id>` (the schema's
//! own provenance pattern — `db.rs` already resolves `drafter` origin refs to
//! draft titles), plus a `parent-child` edge (the id shape's law) and a
//! `replies-to` edge (child replies to its parent request). Chosen over an
//! appended body line because `work_items` has no body-update helper by
//! design (only claim/close/expire ever mutate a row), and machine
//! breadcrumbs do not belong inside the human's own request text. The child
//! files as `held` — a linkage breadcrumb is parked context, never claimable
//! work, so it must not pollute the ready frontier. The PARENT stays `open`:
//! drafting a plan is not doing the work, and the vocabulary reserves `held`
//! for a filer's own parking decision — a machine act hiding an item from
//! the frontier would violate "the machine lands nothing".

use std::process::Stdio;

use serde::Serialize;

use crate::db::Database;
use crate::ledger::{self, EventKind};
use crate::state::SessionStore;
use crate::work::WorkItem;

/// The seat the triage pass runs on. Triage authors a plan-prompt document —
/// drafter-shaped work — so it rides the existing `drafter` seat config.
pub const TRIAGE_SEAT: &str = "drafter";
/// Ledger actor + edge author for everything triage records.
pub const TRIAGE_ACTOR: &str = "intake-triage";

/// What one triage run produced, for whoever invoked the command. The draft
/// appears in the existing Bookshelf/Drafter list by construction — no
/// frontend wiring is needed to surface it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeTriage {
    /// The Bookshelf document the plan-prompt landed in (a NEW document).
    pub draft_id: String,
    pub draft_title: Option<String>,
    /// The triaged work item (unchanged, still `open`).
    pub item_id: String,
    /// The `held` child message item that durably names the draft.
    pub linked_item_id: String,
}

// ---------------------------------------------------------------------------
// Pure construction — prompt, argv, guards (all unit-tested)
// ---------------------------------------------------------------------------

/// The triage prompt: plan-shaped instructions + the raw request VERBATIM.
/// Pure — the whole context is baked in so the core loop never depends on the
/// agent curling anything back.
fn triage_prompt(item: &WorkItem) -> String {
    let mut p = String::from(
        "You are Redline's intake triage agent. A raw request has been filed \
         as a work item. Your ONLY job is to turn it into a well-structured \
         plan-prompt document: the prompt a human will review and redline in \
         their document editor, then launch into a fresh planning session.\n\n\
         Do NOT do the work itself — write no code, change nothing, run no \
         command that mutates anything. You are authoring a prompt, not \
         executing a task.\n\n\
         Output ONLY the document, as markdown, starting with a single `#` \
         title line (the title becomes the document's name). Shape it like a \
         strong planning prompt:\n\
         - `#` a sharp, specific title\n\
         - **Goal** — what done looks like, in one or two sentences\n\
         - **Context** — what the planner needs to know, drawn from the \
         request; where the request is silent, name the gap as an open \
         question instead of inventing facts\n\
         - **Requirements** — concrete, checkable bullets\n\
         - **Out of scope** — what must NOT be touched\n\
         - **Open questions** — everything the request leaves ambiguous\n\n\
         THE RAW REQUEST (verbatim):\n\n",
    );
    p.push_str(&format!("Work item: {} (kind: {})\n", item.id, item.kind));
    p.push_str(&format!("Title: {}\n", item.title));
    match item.body.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(body) => p.push_str(&format!("Body:\n{body}\n")),
        None => p.push_str("Body: (no body was filed — the title is the whole request)\n"),
    }
    if let Some(ok) = item.origin_kind.as_deref() {
        p.push_str(&format!(
            "Origin: {ok}{}\n",
            item.origin_id
                .as_deref()
                .map(|oi| format!(" ({oi})"))
                .unwrap_or_default()
        ));
    }
    if let Some(project) = item.project_path.as_deref() {
        p.push_str(&format!("Project: {project}\n"));
    }
    p
}

/// The full triage argv: the canonical headless bridge block on the `drafter`
/// seat, single turn (no resume). `bridge_args` is the ONE place the
/// invariant flag block lives — never inline a copy.
fn triage_args(prompt: String) -> Vec<String> {
    crate::claude_proc::bridge_args(TRIAGE_SEAT, prompt, None)
}

/// Refuse to spawn with any write-capable escalation in the FINAL argv. The
/// invariant block always carries `--permission-mode default` and a tool
/// surface with no `Edit`/`Write`, but the seat's user-configured
/// `extra_flags` are appended verbatim AFTER it — and the CLI lets a later
/// flag win. The shared `assert_read_only_argv` (also used by the moot)
/// checks every occurrence of the escalation-capable flags
/// (`--permission-mode`, `--dangerously-skip-permissions`,
/// `--tools`/`--allowedTools` naming a write tool), so a seat tweak cannot
/// silently escalate the read-only triage pass into an editing one.
fn read_only_guard(args: &[String]) -> Result<(), String> {
    crate::claude_proc::assert_read_only_argv(args).map_err(|why| {
        format!(
            "the intake triage pass is read-only — {why}; fix the \
             `{TRIAGE_SEAT}` seat's extra flags to run it"
        )
    })
}

/// Mint the linkage child's id: `<parent>.N`, one past the highest existing
/// direct-child ordinal (never reusing a freed one). Mirrors the minting law
/// of `work.rs` exactly — that function is private to the state plane, and
/// the plane's boundary is worth more than sharing ten lines.
fn mint_linkage_child_id(db: &Database, parent: &str) -> String {
    let next = db
        .work_child_ids(parent)
        .iter()
        .filter_map(|id| id.rsplit('.').next()?.parse::<i64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    format!("{parent}.{next}")
}

/// Load + gate + build: the item must exist and be `open` (a claimed item is
/// someone's in-flight work, a held one is parked by its filer, a closed one
/// is finished — triaging any of those would be acting over someone's head).
/// Returns the item with the ready-to-spawn argv.
fn prepare_triage(db: &Database, item_id: &str) -> Result<(WorkItem, Vec<String>), String> {
    let id = item_id.trim();
    let Some(item) = db.get_work_item(id) else {
        return Err(format!("no work item `{id}`"));
    };
    if item.status != "open" {
        return Err(format!(
            "work item `{}` is `{}` — only an open item can be triaged",
            item.id, item.status
        ));
    }
    let args = triage_args(triage_prompt(&item));
    read_only_guard(&args)?;
    Ok((item, args))
}

/// Land one triage run: the plan-prompt as a NEW Bookshelf document (the
/// exact shape the Drafter's read path loads — see the module doc), the
/// `held` child message naming it, both edges, and the chain event via the
/// existing helper. The parent item is deliberately untouched.
fn land_triage(db: &Database, item: &WorkItem, markdown: &str) -> Result<IntakeTriage, String> {
    let draft_id = uuid::Uuid::new_v4().to_string();
    let title = crate::draft_title_from_markdown(markdown);
    db.upsert_draft(
        &draft_id,
        title.as_deref(),
        item.project_path.as_deref(),
        markdown,
        // No TipTap body: the Drafter builds one from the markdown mirror on
        // first open — the house shape for agent-landed documents.
        None,
    )
    .map_err(|e| e.to_string())?;

    let now = ledger::now_millis();
    let make_child = |child_id: &str| WorkItem {
        id: child_id.to_string(),
        title: format!("Plan draft ready: {}", title.as_deref().unwrap_or(&item.title)),
        body: Some(format!(
            "Intake triage turned this request into plan-prompt draft \
             `{draft_id}`. Open it in the Prompt Drafter, redline it, and \
             launch the plan session from there."
        )),
        // A linkage breadcrumb is parked context, never claimable work — it
        // files `held` so it can't enter the ready frontier.
        status: "held".to_string(),
        priority: item.priority,
        kind: "message".to_string(),
        assignee: None,
        claimed_at: None,
        lease_expires_at: None,
        closed_at: None,
        close_reason: None,
        defer_until: None,
        // The schema's own provenance pattern: a TEXT breadcrumb to the
        // draft, never a foreign key.
        origin_kind: Some("drafter".to_string()),
        origin_id: Some(draft_id.clone()),
        project_path: item.project_path.clone(),
        pinned: false,
        created_at: now,
        updated_at: now,
    };
    // Mint + insert can lose a race to a concurrent filer on the same parent
    // (plain INSERT on the PK): on a UNIQUE-constraint loss, re-read the
    // children and retry ONCE so the linkage still lands — the draft above is
    // already written, and a lost linkage would orphan it. A second loss
    // stays loud (and names the orphaned draft for cleanup).
    let mut child_id = String::new();
    let mut inserted = false;
    let mut last_err = String::new();
    for attempt in 0..2 {
        child_id = mint_linkage_child_id(db, &item.id);
        match db.insert_work_item(&make_child(&child_id)) {
            Ok(()) => {
                inserted = true;
                break;
            }
            Err(e) => {
                let unique = matches!(
                    &e,
                    rusqlite::Error::SqliteFailure(f, _)
                        if f.code == rusqlite::ffi::ErrorCode::ConstraintViolation
                );
                last_err = e.to_string();
                if attempt == 0 && unique {
                    tracing::warn!(
                        parent = %item.id, lost = %child_id,
                        "triage linkage id lost to a concurrent filer — re-minting once"
                    );
                    continue;
                }
                break;
            }
        }
    }
    if !inserted {
        return Err(format!(
            "triage landed draft `{draft_id}` but failed to file its linkage \
             child under `{}`: {last_err}",
            item.id
        ));
    }
    // The id shape's law (`<parent>.N` ⇒ a parent-child edge) plus the
    // reply semantic: the child replies to the request it triaged. Edge
    // failures are non-blocking, but never silent.
    if let Err(e) = db.insert_work_edge(&item.id, &child_id, "parent-child", Some(TRIAGE_ACTOR), now)
    {
        tracing::warn!(from = %item.id, to = %child_id, error = %e, "triage parent-child edge insert failed");
    }
    if let Err(e) = db.insert_work_edge(&child_id, &item.id, "replies-to", Some(TRIAGE_ACTOR), now) {
        tracing::warn!(from = %child_id, to = %item.id, error = %e, "triage replies-to edge insert failed");
    }
    // Chain append via the existing helper — succeeds or the failure is
    // logged with the item id, never silently dropped, never blocking.
    if let Err(e) = ledger::record_work_event(
        db,
        EventKind::WorkFile,
        &child_id,
        Some(TRIAGE_ACTOR),
        Some(&format!("plan-draft:{draft_id}")),
        now,
    ) {
        tracing::warn!(item = %child_id, error = %e, "intake triage chain append failed");
    }
    let _ = db.append_journal(
        "intake_triage",
        Some("drafter"),
        Some(&draft_id),
        title.as_deref(),
        Some(&format!("from work item {}", item.id)),
    );
    Ok(IntakeTriage {
        draft_id,
        draft_title: title,
        item_id: item.id.clone(),
        linked_item_id: child_id,
    })
}

// ---------------------------------------------------------------------------
// Spawn + drive — one headless turn, collected silently
// ---------------------------------------------------------------------------

/// Run the single headless triage turn to completion and return its final
/// text. The argv is fully built (and guarded) by the caller.
async fn run_triage(db: &Database, args: Vec<String>) -> Result<String, String> {
    let claude_bin = tokio::task::spawn_blocking(crate::claude_proc::resolve_claude_bin)
        .await
        .map_err(|e| e.to_string())?;
    let mut cmd = crate::claude_proc::claude_command_for_seat(TRIAGE_SEAT, &claude_bin);
    let mut child = cmd
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "could not find the `claude` CLI (looked for `{claude_bin}`). \
                     Install Claude Code, or launch Redline from a terminal."
                )
            } else {
                format!("failed to spawn the triage pass: {e}")
            }
        })?;
    let stdout = child.stdout.take().ok_or("triage stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("triage stderr unavailable")?;
    let out = crate::claude_proc::collect_turn_seated(db, TRIAGE_SEAT, stdout, stderr).await;
    let _ = child.wait().await;
    if let Some(msg) = out.errored {
        return Err(msg);
    }
    match out.final_text.filter(|t| !t.trim().is_empty()) {
        Some(text) => Ok(text),
        None => Err(if out.stderr_text.trim().is_empty() {
            "the triage pass produced no document".to_string()
        } else {
            format!(
                "the triage pass produced no document: {}",
                out.stderr_text.trim()
            )
        }),
    }
}

/// Triage one open work item into a plan-prompt document the human redlines.
/// ON-DEMAND only — this command is the sole entry point; nothing watches,
/// polls, or auto-spawns it.
#[tauri::command(async)]
pub async fn intake_triage(
    store: tauri::State<'_, SessionStore>,
    item_id: String,
) -> Result<IntakeTriage, String> {
    let db = store.database();
    let (item, args) = prepare_triage(&db, &item_id)?;
    // Keep the headless `-p` out of the lake (the global hook would otherwise
    // capture the baked prompt as a human one).
    ledger::register_agent_prompt(&args[1]);
    let markdown = run_triage(&db, args).await?;
    land_triage(&db, &item, &markdown)
}

// ---------------------------------------------------------------------------
// Tests — prompt construction, the read-only argv pin, the open-only gate,
// and the landing round-trip through the Drafter's own read path.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, status: &str) -> WorkItem {
        let now = ledger::now_millis();
        WorkItem {
            id: id.to_string(),
            title: "Ship the frobnicator intake".to_string(),
            body: Some("Users keep pasting raw asks into chat.\nRoute them.".to_string()),
            status: status.to_string(),
            priority: 2,
            kind: "task".to_string(),
            assignee: None,
            claimed_at: None,
            lease_expires_at: None,
            closed_at: None,
            close_reason: None,
            defer_until: None,
            origin_kind: Some("intake".to_string()),
            origin_id: Some("share-77".to_string()),
            project_path: Some("/tmp/proj".to_string()),
            pinned: false,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn triage_prompt_carries_the_request_verbatim_and_plan_shape() {
        let it = item("rl-int1", "open");
        let p = triage_prompt(&it);
        // The raw request rides verbatim — title, every body line, provenance.
        assert!(p.contains("Ship the frobnicator intake"));
        assert!(p.contains("Users keep pasting raw asks into chat.\nRoute them."));
        assert!(p.contains("Work item: rl-int1 (kind: task)"));
        assert!(p.contains("Origin: intake (share-77)"));
        assert!(p.contains("Project: /tmp/proj"));
        // Plan-shaped instructions: a plan-prompt document, markdown, titled,
        // and explicitly NOT doing the work.
        assert!(p.contains("plan-prompt document"));
        assert!(p.contains("planning session"));
        assert!(p.contains("markdown"));
        assert!(p.contains("single `#` title line"));
        assert!(p.contains("Do NOT do the work"));
        // A bodyless item says so instead of inventing content.
        let mut bare = item("rl-int2", "open");
        bare.body = None;
        assert!(triage_prompt(&bare).contains("no body was filed"));
    }

    #[test]
    fn triage_argv_is_headless_read_only_on_the_drafter_seat() {
        let _guard = crate::seat::store_guard();
        crate::seat::set_seat_for_test(
            TRIAGE_SEAT,
            Some(crate::seat::SeatConfig {
                model: Some("sonnet".to_string()),
                ..Default::default()
            }),
        );
        let args = triage_args(triage_prompt(&item("rl-int1", "open")));
        // Headless single turn: `-p <prompt>` + stream-json.
        assert_eq!(args[0], "-p");
        assert!(args.iter().any(|a| a == "stream-json"));
        assert!(!args.iter().any(|a| a == "--resume"));
        // READ-ONLY, pinned on the built argv: no acceptEdits anywhere, the
        // permission mode is `default`, and the tool surface carries no
        // write/plan tools.
        assert!(args.iter().all(|a| !a.contains("acceptEdits")));
        let pm = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pm + 1], "default");
        let tools_idx = args.iter().position(|a| a == "--tools").unwrap();
        let tools = &args[tools_idx + 1];
        assert_eq!(tools, crate::claude_proc::HEADLESS_TOOLS);
        assert!(!tools.split(',').any(|t| t == "Edit" || t == "Write" || t == "ExitPlanMode"));
        // The DRAFTER seat's flags are the ones consumed — triage invents no
        // seat of its own.
        let model_idx = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[model_idx + 1], "sonnet");
        assert!(read_only_guard(&args).is_ok());
        crate::seat::set_seat_for_test(TRIAGE_SEAT, None);
    }

    #[test]
    fn acceptedits_smuggled_via_seat_extra_flags_is_refused() {
        let _guard = crate::seat::store_guard();
        crate::seat::set_seat_for_test(
            TRIAGE_SEAT,
            Some(crate::seat::SeatConfig {
                extra_flags: Some(vec![
                    "--permission-mode".to_string(),
                    "acceptEdits".to_string(),
                ]),
                ..Default::default()
            }),
        );
        let args = triage_args(triage_prompt(&item("rl-int1", "open")));
        let err = read_only_guard(&args).unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        // And the command path enforces it: prepare refuses to hand back argv.
        let db = Database::open_in_memory().unwrap();
        db.insert_work_item(&item("rl-int1", "open")).unwrap();
        assert!(prepare_triage(&db, "rl-int1").unwrap_err().contains("read-only"));
        crate::seat::set_seat_for_test(TRIAGE_SEAT, None);
    }

    #[test]
    fn only_an_open_item_can_be_triaged() {
        // `prepare_triage` builds the argv off the process-global seat store —
        // hold the shared guard so seat-mutating tests can't race this one.
        let _guard = crate::seat::store_guard();
        let db = Database::open_in_memory().unwrap();
        for (id, status) in [
            ("rl-c", "claimed"),
            ("rl-h", "held"),
            ("rl-z", "closed"),
        ] {
            db.insert_work_item(&item(id, status)).unwrap();
            let err = prepare_triage(&db, id).unwrap_err();
            assert!(err.contains(status), "{err}");
            assert!(err.contains("only an open item"), "{err}");
        }
        assert!(prepare_triage(&db, "rl-missing")
            .unwrap_err()
            .contains("no work item"));
        // The open one sails through the gate with a guarded argv.
        db.insert_work_item(&item("rl-o", "open")).unwrap();
        let (it, args) = prepare_triage(&db, " rl-o ").unwrap();
        assert_eq!(it.id, "rl-o");
        assert_eq!(args[0], "-p");
    }

    #[test]
    fn landing_round_trips_through_the_drafter_read_path_and_links_the_item() {
        let db = Database::open_in_memory().unwrap();
        let it = item("rl-tri", "open");
        db.insert_work_item(&it).unwrap();
        let markdown = "# Frobnicator intake plan prompt\n\n**Goal** — route raw asks.\n";
        let out = land_triage(&db, &it, markdown).unwrap();

        // The document round-trips through the SAME read path the Drafter UI
        // uses (`drafter_get_doc` → `get_draft_doc`): no TipTap body (the
        // frontend builds one from the mirror on first open — the Shipwright
        // shape), the markdown exact, the item's project carried over.
        let (doc_json, doc_md, project) = db.get_draft_doc(&out.draft_id).unwrap().unwrap();
        assert_eq!(doc_json, None);
        assert_eq!(doc_md, markdown);
        assert_eq!(project.as_deref(), Some("/tmp/proj"));
        // And through the Bookshelf list (the shelf's read path): present,
        // titled from the heading, flagged as mirror-only.
        let row = db
            .list_drafts()
            .unwrap()
            .into_iter()
            .find(|d| d.draft_id == out.draft_id)
            .expect("the draft is on the shelf");
        assert_eq!(row.title.as_deref(), Some("Frobnicator intake plan prompt"));
        assert!(!row.has_doc, "mirror-only — the FE builds the body");
        assert_eq!(out.draft_title.as_deref(), Some("Frobnicator intake plan prompt"));

        // Durable linkage: a held child message carrying drafter provenance.
        assert_eq!(out.linked_item_id, "rl-tri.1");
        let child = db.get_work_item("rl-tri.1").unwrap();
        assert_eq!(child.kind, "message");
        assert_eq!(child.status, "held");
        assert_eq!(child.origin_kind.as_deref(), Some("drafter"));
        assert_eq!(child.origin_id.as_deref(), Some(out.draft_id.as_str()));
        assert!(child.body.unwrap().contains(&out.draft_id));
        // Both edges, in their canonical directions.
        let edges = db.list_work_edges_touching("rl-tri.1").unwrap();
        assert!(edges
            .iter()
            .any(|e| e.edge_type == "parent-child" && e.from_id == "rl-tri" && e.to_id == "rl-tri.1"));
        assert!(edges
            .iter()
            .any(|e| e.edge_type == "replies-to" && e.from_id == "rl-tri.1" && e.to_id == "rl-tri"));

        // The parent stays OPEN — drafting a plan is not doing the work.
        assert_eq!(db.get_work_item("rl-tri").unwrap().status, "open");

        // The chain event landed via the existing helper, naming the draft,
        // and the chain stays verifiable end-to-end.
        let events = db.list_ledger_events(10).unwrap();
        assert!(events.iter().any(|e| e.kind == "work_file"
            && e.ref_kind.as_deref() == Some("work_item")
            && e.ref_id.as_deref() == Some("rl-tri.1")));
        assert!(db.verify_ledger_chain().unwrap().ok, "chain intact");
    }

    #[test]
    fn smuggled_write_flags_after_the_invariant_block_are_refused() {
        let _guard = crate::seat::store_guard();
        // Each smuggle rides in via seat `extra_flags` — appended AFTER the
        // invariant block, exactly where a later flag would win in the CLI.
        let smuggles: Vec<Vec<&str>> = vec![
            vec!["--permission-mode", "bypassPermissions"],
            vec!["--permission-mode=acceptEdits"],
            vec!["--dangerously-skip-permissions"],
            vec!["--allowedTools", "Edit"],
            vec!["--tools", "Read,NotebookEdit"],
        ];
        let db = Database::open_in_memory().unwrap();
        db.insert_work_item(&item("rl-int1", "open")).unwrap();
        for smuggle in smuggles {
            crate::seat::set_seat_for_test(
                TRIAGE_SEAT,
                Some(crate::seat::SeatConfig {
                    extra_flags: Some(smuggle.iter().map(|s| s.to_string()).collect()),
                    ..Default::default()
                }),
            );
            let args = triage_args(triage_prompt(&item("rl-int1", "open")));
            let err = read_only_guard(&args).unwrap_err();
            assert!(err.contains("read-only"), "{smuggle:?}: {err}");
            // And the command path enforces it end-to-end.
            assert!(
                prepare_triage(&db, "rl-int1").unwrap_err().contains("read-only"),
                "{smuggle:?}"
            );
        }
        crate::seat::set_seat_for_test(TRIAGE_SEAT, None);
    }

    #[test]
    fn concurrent_triages_both_land_their_linkage() {
        // The mint+insert race: two landings on the same parent must BOTH
        // file a linkage child (the loser re-mints once), never orphan a
        // draft on a UNIQUE-constraint loss.
        use std::sync::Arc;
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.insert_work_item(&item("rl-race", "open")).unwrap();
        let mut handles = Vec::new();
        for n in 0..2 {
            let db = Arc::clone(&db);
            handles.push(std::thread::spawn(move || {
                land_triage(&db, &item("rl-race", "open"), &format!("# Plan {n}\n")).unwrap()
            }));
        }
        let mut ids: Vec<String> = handles
            .into_iter()
            .map(|h| h.join().unwrap().linked_item_id)
            .collect();
        ids.sort();
        assert_eq!(ids, ["rl-race.1", "rl-race.2"]);
    }

    #[test]
    fn the_linkage_child_never_enters_the_ready_pool_and_ordinals_walk_forward() {
        let db = Database::open_in_memory().unwrap();
        let it = item("rl-rdy", "open");
        db.insert_work_item(&it).unwrap();
        let now = ledger::now_millis();
        land_triage(&db, &it, "# Plan A\n").unwrap();
        // The parent is still the claimable frontier; the breadcrumb is not.
        let ready = db.list_ready_work_items(None, now, 50).unwrap();
        let ids: Vec<&str> = ready.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"rl-rdy"));
        assert!(!ids.contains(&"rl-rdy.1"));
        // A second triage files the NEXT ordinal — freed or not, never reused.
        let again = land_triage(&db, &it, "# Plan B\n").unwrap();
        assert_eq!(again.linked_item_id, "rl-rdy.2");
    }
}
