// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The harness data model (program A2) — user-authored agents as ROWS.
//!
//! An agent on the shelf is a name plus a plain-English instruction
//! (`harness_agents`, db.rs): named, foldered, starrable, duplicable — the
//! `drafts` + `is_template` shape, minus "instantiate as a new doc", plus
//! **"run against the open doc"**. Running one composes its row into a prompt
//! at run time (`compose.rs` — never `~/.claude/skills`, never `skill.rs`;
//! a7be07f stands) and spawns it as a guest turn on the Drafter document's
//! discussion (`DraftChatState::run_shelf_agent`), where its output lands
//! through the existing four-op tracked-suggestion contract verbatim —
//! `POST /v1/drafter/:id/suggestions`, 400/403/409 staleness — so nothing an
//! agent writes applies unreviewed (invariant #7).
//!
//! Spawn config: the `harness` template seat, unless the agent has its own
//! `custom:<agent_id>` seat row (`seat::CUSTOM_SEAT_PREFIX` — the validated
//! escape hatch through the otherwise-closed `KNOWN_SEATS`).

use crate::compose::{compose, AuthoredBlock, PromptLayers};
use crate::db::HarnessAgent;
use crate::state::SessionStore;

// --- Prompt composition ------------------------------------------------------

/// Layer 1 — byte-identical across every agent, draft and run. The role and
/// the run contract; everything agent- or draft-specific rides below it.
const AGENT_RUN_ROLE: &str = "\
You are one of the user's OWN agents — an agent they authored on their shelf \
in Redline, run on demand against the document open in the Prompt Drafter. \
Your standing instruction (below, fenced) was written by the user in plain \
English. Execute it against the CURRENT DOCUMENT.\n\
\n\
THE RUN CONTRACT:\n\
- Land every document edit through the suggestions endpoint below, so each \
one renders as a tracked change the user accepts or rejects in place. Never \
assume an edit landed; re-read the doc to see the outcome.\n\
- If the instruction asks a question or a check rather than an edit, answer \
in chat and post nothing.\n\
- Finish with ONE short chat line — what you did and anything worth flagging. \
The content lives in the document, never restated in chat.\n\
\n\
FORMATTING — your replies render through Redline's markdown pipeline \
(tables, fenced code, mermaid). Never emit raw HTML.";

/// The run prompt for one shelf agent against one draft, composed strictly
/// most-stable-first (invariant #8): the invariant role, the per-draft doc
/// route + write contract (reused verbatim from the drafter discussion
/// agent), the per-agent fenced instruction, then the per-run document body.
/// Two runs of the same agent on the same draft share a byte-identical
/// cacheable prefix through the instruction — guarded by
/// `first_turn_invariant_prefix_is_byte_stable` below.
pub(crate) fn build_agent_run_prompt(
    draft_id: &str,
    agent: &HarnessAgent,
    doc_markdown: &str,
) -> String {
    let target = [
        crate::draft_chat::doc_route_block(draft_id),
        crate::draft_chat::suggestions_contract(draft_id),
    ];
    let label = format!("AGENT INSTRUCTION — {}", agent.name);
    let authored = [AuthoredBlock {
        label: &label,
        text: &agent.instruction,
    }];
    // Agent-stable, so it leads the variable layer: run-over-run the shared
    // prefix extends through it, and only the document body breaks it.
    let attribution = format!(
        "Attribution: when you POST a suggestion, set \"agent_id\" to \
         \"shelf:{}\" (not \"draft-agent\") — that is how the document \
         attributes the change to this agent.",
        agent.agent_id
    );
    let body = doc_markdown.trim();
    let doc = if body.is_empty() {
        "--- CURRENT DOCUMENT ---\n(the document is empty)\n--- END DOCUMENT ---".to_string()
    } else {
        format!("--- CURRENT DOCUMENT ---\n{body}\n--- END DOCUMENT ---")
    };
    compose(&PromptLayers {
        invariant: AGENT_RUN_ROLE,
        target: &target,
        authored: &authored,
        variable: &[attribution, doc],
    })
}

// --- Row lifecycle (cores are plain functions so tests reach them) -----------

fn fresh_agent_id() -> String {
    format!("ha-{}", uuid::Uuid::new_v4())
}

fn create_agent_core(
    db: &crate::db::Database,
    name: &str,
    instruction: &str,
) -> Result<HarnessAgent, String> {
    let name = name.trim();
    let instruction = instruction.trim();
    if name.is_empty() {
        return Err("the agent needs a name".to_string());
    }
    if instruction.is_empty() {
        return Err("the agent needs an instruction — that IS the agent".to_string());
    }
    let now = crate::ledger::now_millis();
    let agent = HarnessAgent {
        agent_id: fresh_agent_id(),
        name: name.to_string(),
        instruction: instruction.to_string(),
        folder_id: None,
        starred: false,
        created_at: now,
        updated_at: now,
        last_run_at: None,
        run_count: 0,
    };
    db.insert_harness_agent(&agent).map_err(|e| e.to_string())?;
    Ok(agent)
}

fn delete_agent_core(db: &crate::db::Database, agent_id: &str) -> Result<(), String> {
    // The seat row goes first: once the agent row is gone, `set_seat` could
    // never admit — and so never clear — its `custom:<id>` key.
    crate::seat::clear_custom_seat(db, agent_id)?;
    if !db.delete_harness_agent(agent_id).map_err(|e| e.to_string())? {
        return Err("no such agent".to_string());
    }
    Ok(())
}

// --- Commands ----------------------------------------------------------------

#[tauri::command(async)]
pub fn harness_agent_create(
    store: tauri::State<'_, SessionStore>,
    name: String,
    instruction: String,
) -> Result<HarnessAgent, String> {
    create_agent_core(&store.database(), &name, &instruction)
}

/// The whole shelf, most-recently-updated first.
#[tauri::command(async)]
pub fn harness_agent_list(
    store: tauri::State<'_, SessionStore>,
) -> Result<Vec<HarnessAgent>, String> {
    store.database().list_harness_agents().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn harness_agent_update(
    store: tauri::State<'_, SessionStore>,
    agent_id: String,
    name: String,
    instruction: String,
) -> Result<(), String> {
    let name = name.trim();
    let instruction = instruction.trim();
    if name.is_empty() || instruction.is_empty() {
        return Err("an agent keeps both a name and an instruction".to_string());
    }
    if !store
        .database()
        .update_harness_agent(&agent_id, name, instruction)
        .map_err(|e| e.to_string())?
    {
        return Err("no such agent".to_string());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn harness_agent_set_starred(
    store: tauri::State<'_, SessionStore>,
    agent_id: String,
    starred: bool,
) -> Result<(), String> {
    store
        .database()
        .set_harness_agent_starred(&agent_id, starred)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn harness_agent_set_folder(
    store: tauri::State<'_, SessionStore>,
    agent_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    store
        .database()
        .set_harness_agent_folder(&agent_id, folder_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Delete an agent and its `custom:<id>` seat row, if it grew one.
#[tauri::command(async)]
pub fn harness_agent_delete(
    store: tauri::State<'_, SessionStore>,
    agent_id: String,
) -> Result<(), String> {
    delete_agent_core(&store.database(), &agent_id)
}

#[tauri::command(async)]
pub fn harness_agent_duplicate(
    store: tauri::State<'_, SessionStore>,
    agent_id: String,
) -> Result<HarnessAgent, String> {
    store
        .database()
        .duplicate_harness_agent(&agent_id, &fresh_agent_id())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no such agent".to_string())
}

/// Run one shelf agent against the open Drafter document — the A2 gate.
/// `draft_markdown` is the live doc from an open drafter pane (mirrored
/// server-side before the run); omitted, the stored mirror is the doc.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn harness_agent_run(
    chat: tauri::State<'_, crate::draft_chat::DraftChatState>,
    store: tauri::State<'_, SessionStore>,
    app: tauri::AppHandle,
    agent_id: String,
    draft_id: String,
    draft_markdown: Option<String>,
    project_path: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let db = store.database();
    let agent = db
        .get_harness_agent(&agent_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no such agent".to_string())?;
    chat.run_shelf_agent(app, agent, draft_id, draft_markdown, project_path, cwd, false)
        .await?;
    // The spawn is live — count the run (never reorders the shelf).
    if let Err(e) = db.touch_harness_agent_run(&agent_id) {
        tracing::warn!(error = %e, "failed to record shelf agent run");
    }
    Ok(())
}

// --- Preview-on-a-copy (A3) --------------------------------------------------
//
// The builder's gate is seeing what an instruction DOES before the agent
// exists. `harness_agent_run` needs a saved row; this variant needs none: a
// transient agent (never inserted) runs against a transient COPY of the open
// document (`preview-<uuid>` — a real `drafts` row, because the write
// contract's staleness checks and the suggestion queue are keyed to one), so
// the open document is untouched by construction. Preview drafts are
// invisible everywhere (`list_drafts` filters the prefix), are discarded by
// the builder when it is done, and any the builder never got to discard are
// swept here a session later.

/// Older than this, an undiscarded preview draft is presumed orphaned.
const PREVIEW_STALE_MS: i64 = 60 * 60 * 1000;

fn fresh_preview_id() -> String {
    format!("preview-{}", uuid::Uuid::new_v4())
}

/// Run an UNSAVED instruction against a copy of `draft_id`'s document.
/// Returns the preview draft's id — the caller subscribes to that id's
/// `drafter-suggestion` / `draft-chat-*` events and discards it when done.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn harness_agent_preview(
    chat: tauri::State<'_, crate::draft_chat::DraftChatState>,
    store: tauri::State<'_, SessionStore>,
    app: tauri::AppHandle,
    name: String,
    instruction: String,
    draft_id: String,
    draft_markdown: Option<String>,
    project_path: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let name = name.trim().to_string();
    let instruction = instruction.trim().to_string();
    if name.is_empty() {
        return Err("the agent needs a name".to_string());
    }
    if instruction.is_empty() {
        return Err("the agent needs an instruction — that IS the agent".to_string());
    }
    let db = store.database();
    sweep_stale_previews(&db);

    // The copy: the live markdown from the open pane, or the stored mirror.
    let markdown = match draft_markdown {
        Some(md) => md,
        None => {
            db.get_draft(&draft_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "no such draft".to_string())?
                .2
        }
    };

    let now = crate::ledger::now_millis();
    let preview_id = fresh_preview_id();
    let agent = HarnessAgent {
        agent_id: preview_id.clone(),
        name,
        instruction,
        folder_id: None,
        starred: false,
        created_at: now,
        updated_at: now,
        last_run_at: None,
        run_count: 0,
    };
    chat.run_shelf_agent(
        app,
        agent,
        preview_id.clone(),
        Some(markdown),
        project_path,
        cwd,
        true,
    )
    .await?;
    Ok(preview_id)
}

/// Throw a preview copy away — the builder is done with it. Guarded to the
/// `preview-` id space so no caller can reach a real document through it.
#[tauri::command(async)]
pub fn harness_preview_discard(
    store: tauri::State<'_, SessionStore>,
    preview_id: String,
) -> Result<(), String> {
    if !preview_id.starts_with("preview-") {
        return Err("not a preview draft".to_string());
    }
    store
        .database()
        .delete_draft(&preview_id)
        .map_err(|e| e.to_string())
}

fn sweep_stale_previews(db: &crate::db::Database) {
    let cutoff = crate::ledger::now_millis() - PREVIEW_STALE_MS;
    match db.list_stale_preview_drafts(cutoff) {
        Ok(ids) => {
            for id in ids {
                if let Err(e) = db.delete_draft(&id) {
                    tracing::warn!(error = %e, id, "failed to sweep stale preview draft");
                }
            }
        }
        Err(e) => tracing::warn!(error = %e, "failed to list stale preview drafts"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn agent(id: &str, name: &str, instruction: &str) -> HarnessAgent {
        HarnessAgent {
            agent_id: id.to_string(),
            name: name.to_string(),
            instruction: instruction.to_string(),
            folder_id: None,
            starred: false,
            created_at: 1000,
            updated_at: 1000,
            last_run_at: None,
            run_count: 0,
        }
    }

    #[test]
    fn run_prompt_carries_role_contract_instruction_attribution_and_doc() {
        let a = agent("ha-1", "Header tightener", "Tighten every heading to five words.");
        let p = build_agent_run_prompt("d-1", &a, "# Goal\n\nShip auth.");
        // The verbatim drafter write contract, per-draft.
        assert!(p.contains("/v1/drafter/d-1/doc"));
        assert!(p.contains("/v1/drafter/d-1/suggestions"));
        assert!(p.contains("replace_block"));
        assert!(p.contains("--variable %REDLINE_DAEMON_TOKEN="));
        assert!(!p.contains("Bearer $REDLINE_DAEMON_TOKEN"));
        // The user's words, fenced and labeled with the agent's name.
        assert!(p.contains("--- BEGIN AGENT INSTRUCTION — Header tightener ---"));
        assert!(p.contains("Tighten every heading to five words."));
        assert!(p.contains("--- END AGENT INSTRUCTION — Header tightener ---"));
        // Attribution + the doc.
        assert!(p.contains("\"shelf:ha-1\""));
        assert!(p.contains("--- CURRENT DOCUMENT ---"));
        assert!(p.contains("Ship auth."));
        // A row composed at run time, never a skill (a7be07f).
        assert!(!p.contains("skill"), "shelf agents must never be taught as skills");
    }

    #[test]
    fn run_prompt_marks_an_empty_document() {
        let a = agent("ha-1", "Drafter", "Draft an outline.");
        let p = build_agent_run_prompt("d-1", &a, "   ");
        assert!(p.contains("(the document is empty)"));
    }

    /// The A2 gate invariant (#8), at the new seat: two runs of the SAME
    /// agent on the SAME draft share a byte-identical prefix spanning the
    /// role, the doc route, the whole write contract, the fenced instruction
    /// and the attribution line — only the document body varies. And two
    /// DIFFERENT agents on one draft still share everything up through the
    /// write contract.
    #[test]
    fn first_turn_invariant_prefix_is_byte_stable() {
        fn common_prefix<'a>(a: &'a str, b: &str) -> &'a str {
            let n = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
            &a[..n]
        }
        let tightener = agent("ha-1", "Tightener", "Tighten every heading.");
        let a = build_agent_run_prompt("d-1", &tightener, "# Body one");
        let b = build_agent_run_prompt("d-1", &tightener, "# A completely different body");
        let shared = common_prefix(&a, &b);
        assert!(shared.contains("THE RUN CONTRACT"));
        assert!(shared.contains("/v1/drafter/d-1/doc"));
        assert!(shared.contains("/v1/drafter/d-1/suggestions"));
        assert!(shared.contains("✦ INSTRUCTION TURNS"), "spans the whole write contract");
        assert!(shared.contains("--- END AGENT INSTRUCTION — Tightener ---"));
        assert!(shared.contains("\"shelf:ha-1\""));
        assert!(!shared.contains("Body one"));

        let summarizer = agent("ha-2", "Summarizer", "Summarize each section.");
        let c = build_agent_run_prompt("d-1", &summarizer, "# Body one");
        let across = common_prefix(&a, &c);
        assert!(across.contains("✦ INSTRUCTION TURNS"), "agents share the per-draft prefix");
        assert!(!across.contains("Tightener"));
    }

    #[test]
    fn create_validates_and_delete_clears_the_custom_seat() {
        let db = Database::open_in_memory().unwrap();
        assert!(create_agent_core(&db, "  ", "do things").is_err());
        assert!(create_agent_core(&db, "Namer", "   ").is_err());

        let a = create_agent_core(&db, "  Namer  ", "  Name things well.  ").unwrap();
        assert_eq!(a.name, "Namer", "trimmed");
        assert_eq!(a.instruction, "Name things well.");
        assert!(a.agent_id.starts_with("ha-"));

        // Grow a custom seat, then delete: the seat row must go with the agent.
        crate::seat::set_seat(
            &db,
            &crate::seat::custom_seat(&a.agent_id),
            crate::seat::SeatConfig {
                model: Some("opus".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        delete_agent_core(&db, &a.agent_id).unwrap();
        assert!(db.get_harness_agent(&a.agent_id).unwrap().is_none());
        assert!(
            crate::seat::flag_args(&crate::seat::custom_seat(&a.agent_id)).is_empty(),
            "the custom seat row must not outlive its agent"
        );
        assert!(delete_agent_core(&db, &a.agent_id).is_err(), "second delete errors");
    }
}
