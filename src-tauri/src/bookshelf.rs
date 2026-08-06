// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Bookshelf — **primary storage** for the documents you author in the
//! Prompt Drafter, revisit, review, and launch into a plan session.
//!
//! Two things distinguish it from the single-draft drafter it replaces:
//!
//! 1. **The document lives here.** The TipTap fidelity source used to sit in
//!    localStorage (`drafts.doc_markdown` was an explicitly lossy, derived
//!    mirror), where a cache clear would wipe it. Survivable for one scratch
//!    draft; not survivable for a shelf you revisit. It is now `drafts.doc_json`
//!    and the mirror stays exactly what it was — what agents read via
//!    `GET /v1/drafter/:id/doc`.
//! 2. **Documents have a location.** `bookshelf_folders` is an adjacency list;
//!    a document carries `folder_id`. Move and rename are one row update.
//!
//! `mirror.rs` is unaffected and stays what it is: a one-way, opt-in,
//! rebuildable **export**. There is no second vault and no ambiguity about which
//! copy is real.
//!
//! ## Folders hold documents only
//!
//! A dropped PDF attaches **to** the document it informs (`draft_sources`); it
//! is never a loose sibling on the shelf. Written down here so a later session
//! doesn't relax it as an obvious improvement: every shelf item stays
//! **reviewable**, **agent-attached** and **launch-into-plan**, which is the
//! only reason to build this inside Redline rather than use Finder. Allow loose
//! files and most of the shelf loses all three and becomes a worse file manager
//! with an extra sync surface.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::db::{BookshelfDraft, BookshelfFolder, DeleteImpact, DraftSource};
use crate::state::SessionStore;

/// Attached files live at `<app_data_dir>/bookshelf/<draft_id>/<name>` — the
/// same backup unit as `redline.db`, `attachments/` and `thumbs/`.
const BOOKSHELF_DIR: &str = "bookshelf";

/// Cap on one attached file, matching `fsbrowse`'s attachment cap: big enough
/// for any paper or screenshot, small enough that a stray multi-hundred-MB file
/// can't quietly fill app data.
const MAX_SOURCE_BYTES: u64 = 16 * 1024 * 1024;

/// The whole shelf in one read: folders (adjacency edges) + documents. The
/// frontend builds the tree, exactly as `ClassMemoryPane`'s `buildTree` and
/// `lib/reviewTree.ts` already do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub folders: Vec<BookshelfFolder>,
    pub drafts: Vec<BookshelfDraft>,
}

/// Resolve (and create) a document's source directory. `draft_id` reaches here
/// from the frontend, so it is sanitized to a bare basename before it becomes a
/// path component — a `../` in it would otherwise escape the app-data root.
fn source_dir(app: &tauri::AppHandle, draft_id: &str) -> Result<PathBuf, String> {
    let id = crate::sanitize_basename(draft_id);
    if id.is_empty() {
        return Err("invalid draft id".to_string());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join(BOOKSHELF_DIR)
        .join(id);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// Remove a document's whole source directory. Best-effort — a missing
/// directory is success — so a delete never fails on filesystem state.
fn remove_source_dir(app: &tauri::AppHandle, draft_id: &str) {
    let id = crate::sanitize_basename(draft_id);
    if id.is_empty() {
        return;
    }
    let Ok(root) = app.path().app_data_dir() else {
        return;
    };
    let dir = root.join(BOOKSHELF_DIR).join(id);
    if let Err(e) = fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %e, dir = %dir.display(), "failed to delete bookshelf sources");
        }
    }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn bookshelf_list(store: tauri::State<'_, SessionStore>) -> Result<Shelf, String> {
    let db = store.database();
    Ok(Shelf {
        folders: db.list_folders().map_err(|e| e.to_string())?,
        drafts: db.list_drafts().map_err(|e| e.to_string())?,
    })
}

/// Mint a new document on the shelf and return its id. The row exists
/// immediately so the document has a home before the first keystroke — the
/// drafter's debounce then fills in its body.
///
/// With `from_draft_id` (instantiating a template — or duplicating any
/// document), the source's `title`, `doc_json`, `doc_markdown` and
/// `project_path` are deep-copied; the copy is always an ordinary document
/// (`is_template` stays 0). Sources, comments, suggestions and chat threads
/// are deliberately NOT copied — a template yields a clean document. Block ids
/// (`blk-…`) copy as-is: they are scoped per draft, and `DraftBlockIds`
/// only mints ids that are missing.
#[tauri::command(async)]
pub fn bookshelf_new_draft(
    store: tauri::State<'_, SessionStore>,
    folder_id: Option<String>,
    title: Option<String>,
    project_path: Option<String>,
    from_draft_id: Option<String>,
) -> Result<String, String> {
    let draft_id = uuid::Uuid::new_v4().to_string();
    let db = store.database();
    let from = from_draft_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(src) = from {
        let copied = db
            .copy_draft_body(src, &draft_id, project_path.as_deref())
            .map_err(|e| e.to_string())?;
        if !copied {
            return Err("that template no longer exists".to_string());
        }
    } else {
        let title = title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "Untitled document".to_string());
        db.upsert_draft(
            &draft_id,
            Some(&title),
            project_path.as_deref(),
            "",
            // An empty document, not "no document": the shelf row is real from now on.
            Some(""),
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(folder) = folder_id.as_deref() {
        db.move_draft(&draft_id, Some(folder))
            .map_err(|e| e.to_string())?;
    }
    Ok(draft_id)
}

/// Flip a document's template flag (the shelf's ★ toggle).
#[tauri::command(async)]
pub fn bookshelf_set_template(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
    is_template: bool,
) -> Result<(), String> {
    store
        .database()
        .set_draft_template(&draft_id, is_template)
        .map_err(|e| e.to_string())
}

/// Count one open of a document — the documents dropdown's FREQUENT signal.
/// Called once per open, never per keystroke and never on activation-switch
/// of an already-open document.
#[tauri::command(async)]
pub fn bookshelf_touch_draft(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
) -> Result<(), String> {
    store
        .database()
        .touch_draft(&draft_id)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn bookshelf_rename_draft(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
    title: String,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("a document needs a name".to_string());
    }
    store
        .database()
        .rename_draft(&draft_id, title)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn bookshelf_move_draft(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    store
        .database()
        .move_draft(&draft_id, folder_id.as_deref())
        .map_err(|e| e.to_string())
}

/// What deleting this document would destroy — the numbers the confirm dialog
/// names before anything goes.
#[tauri::command(async)]
pub fn bookshelf_draft_impact(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
) -> Result<DeleteImpact, String> {
    store
        .database()
        .draft_delete_impact(&draft_id)
        .map_err(|e| e.to_string())
}

/// Delete a document and its cascade. Not idempotent, no undo, and it destroys
/// the only copy of the document — the caller gates it behind a typed-title
/// confirm naming exactly what goes.
#[tauri::command(async)]
pub fn bookshelf_delete_draft(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
) -> Result<(), String> {
    store
        .database()
        .delete_draft(&draft_id)
        .map_err(|e| e.to_string())?;
    remove_source_dir(&app, &draft_id);
    Ok(())
}

/// The `app_settings` key that makes the localStorage→DB migration run exactly
/// once. It lives in the DB, not localStorage — the whole point of the move is
/// that a cache clear must not be able to lose or re-run the migration.
const SETTING_MIGRATED: &str = "redline.bookshelf.migrated";

/// Outcome of the one-time migration, so the caller knows whether to reload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationOutcome {
    /// True only on the run that actually moved something.
    pub migrated: bool,
    /// The document the migration adopted, if any.
    pub draft_id: Option<String>,
}

/// Move the drafter's pre-Bookshelf document out of localStorage and into the
/// DB. Frontend-initiated because **only the webview can read localStorage**;
/// idempotent because the "done" flag is a DB setting.
///
/// It cannot lose the existing draft: the markdown mirror is already in the DB
/// and is left untouched, so the TipTap JSON is the only thing at risk, and it
/// is written before the flag is set. A failure part-way leaves the flag unset
/// and the next launch retries.
#[tauri::command(async)]
pub fn bookshelf_migrate_local(
    store: tauri::State<'_, SessionStore>,
    draft_id: Option<String>,
    doc_json: Option<String>,
    project_path: Option<String>,
) -> Result<MigrationOutcome, String> {
    let db = store.database();
    if db.get_setting(SETTING_MIGRATED).is_some() {
        return Ok(MigrationOutcome {
            migrated: false,
            draft_id: None,
        });
    }
    let mut adopted = None;
    if let (Some(id), Some(json)) = (
        draft_id.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        doc_json.as_deref().filter(|s| !s.trim().is_empty()),
    ) {
        // Keep whatever markdown mirror the row already has — it is the
        // independent survival copy if anything about this goes wrong.
        let existing = db.get_draft_doc(id).map_err(|e| e.to_string())?;
        let (_, markdown, stored_project) = existing.unwrap_or((None, String::new(), None));
        let title = crate::draft_title_from_markdown(&markdown);
        db.upsert_draft(
            id,
            title.as_deref(),
            project_path.as_deref().or(stored_project.as_deref()),
            &markdown,
            Some(json),
        )
        .map_err(|e| e.to_string())?;
        adopted = Some(id.to_string());
    }
    db.set_setting(SETTING_MIGRATED, "1")
        .map_err(|e| e.to_string())?;
    Ok(MigrationOutcome {
        migrated: adopted.is_some(),
        draft_id: adopted,
    })
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn bookshelf_create_folder(
    store: tauri::State<'_, SessionStore>,
    parent_id: Option<String>,
    name: String,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a folder needs a name".to_string());
    }
    let folder_id = uuid::Uuid::new_v4().to_string();
    store
        .database()
        .create_folder(&folder_id, parent_id.as_deref(), name)
        .map_err(|e| e.to_string())?;
    Ok(folder_id)
}

#[tauri::command(async)]
pub fn bookshelf_rename_folder(
    store: tauri::State<'_, SessionStore>,
    folder_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a folder needs a name".to_string());
    }
    store
        .database()
        .rename_folder(&folder_id, name)
        .map_err(|e| e.to_string())
}

/// Reparent a folder. Rejects a move into the folder's own subtree — see
/// `db::folder_move_rejection`, where the rule is a pure, tested function.
#[tauri::command(async)]
pub fn bookshelf_move_folder(
    store: tauri::State<'_, SessionStore>,
    folder_id: String,
    parent_id: Option<String>,
) -> Result<(), String> {
    store
        .database()
        .move_folder(&folder_id, parent_id.as_deref())
}

#[tauri::command(async)]
pub fn bookshelf_folder_impact(
    store: tauri::State<'_, SessionStore>,
    folder_id: String,
) -> Result<DeleteImpact, String> {
    store
        .database()
        .folder_delete_impact(&folder_id)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn bookshelf_delete_folder(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    folder_id: String,
) -> Result<(), String> {
    let deleted = store
        .database()
        .delete_folder(&folder_id)
        .map_err(|e| e.to_string())?;
    for draft_id in deleted {
        remove_source_dir(&app, &draft_id);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Sources (attached to a document, never to a folder)
// ---------------------------------------------------------------------------

/// Attach a non-file source: a captured `browse_events` page, a
/// `mission_findings` row, a bare URL, or a digest the agent wrote.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn draft_source_add(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
    kind: String,
    ref_id: Option<String>,
    url: Option<String>,
    title: Option<String>,
    excerpt: Option<String>,
) -> Result<DraftSource, String> {
    if draft_id.trim().is_empty() {
        return Err("missing draft id".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let db = store.database();
    db.add_draft_source(
        &id,
        &draft_id,
        &kind,
        ref_id.as_deref(),
        url.as_deref(),
        title.as_deref(),
        excerpt.as_deref(),
        None,
    )
    .map_err(|e| e.to_string())?;
    db.list_draft_sources(&draft_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "the source vanished on write".to_string())
}

/// Copy a dropped file into this document's source directory and attach it.
/// Reuses `fsbrowse`'s attachment discipline: copy at capture time (a source
/// the user later moves or trashes would break silently), sanitize the
/// basename, and refuse anything over the 16 MB cap.
#[tauri::command(async)]
pub fn draft_source_import_file(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
    src_path: String,
) -> Result<DraftSource, String> {
    if draft_id.trim().is_empty() {
        return Err("missing draft id".to_string());
    }
    let src = Path::new(&src_path);
    let meta = fs::metadata(src).map_err(|e| format!("{src_path}: {e}"))?;
    if meta.is_dir() {
        return Err("folders can't be attached — pick a file".to_string());
    }
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "that file is larger than the {} MB attachment limit",
            MAX_SOURCE_BYTES / (1024 * 1024)
        ));
    }
    let dir = source_dir(&app, &draft_id)?;
    let name = crate::sanitize_basename(&src_path);
    let name = if name.is_empty() {
        "source".to_string()
    } else {
        name
    };
    let dest = crate::dedup_path(&dir, &name);
    fs::copy(src, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let stored = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(name);

    let id = uuid::Uuid::new_v4().to_string();
    let db = store.database();
    db.add_draft_source(
        &id,
        &draft_id,
        "file",
        None,
        None,
        Some(&stored),
        None,
        // Relative to <app_data_dir>/bookshelf/<draft_id>/ — an absolute path
        // would break the moment app data moved (a restore onto a new machine).
        Some(&stored),
    )
    .map_err(|e| e.to_string())?;
    db.list_draft_sources(&draft_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "the source vanished on write".to_string())
}

#[tauri::command(async)]
pub fn draft_source_list(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
) -> Result<Vec<DraftSource>, String> {
    store
        .database()
        .list_draft_sources(&draft_id)
        .map_err(|e| e.to_string())
}

/// Detach a source. A file-backed one takes its file with it — orphaned bytes
/// under app data are exactly the sync surface the "documents only" rule exists
/// to avoid.
#[tauri::command(async)]
pub fn draft_source_delete(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    let removed = store
        .database()
        .delete_draft_source(&id)
        .map_err(|e| e.to_string())?;
    if let Some((draft_id, file)) = removed {
        if let Ok(dir) = source_dir(&app, &draft_id) {
            let name = crate::sanitize_basename(&file);
            if !name.is_empty() {
                let _ = fs::remove_file(dir.join(name));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::{folder_move_rejection, folder_subtree, Database};

    fn edges(pairs: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        pairs
            .iter()
            .map(|(id, p)| (id.to_string(), p.map(str::to_string)))
            .collect()
    }

    #[test]
    fn subtree_collects_descendants_and_terminates_on_a_cycle() {
        let e = edges(&[
            ("a", None),
            ("b", Some("a")),
            ("c", Some("b")),
            ("d", None),
        ]);
        let mut sub = folder_subtree(&e, "a");
        sub.sort();
        assert_eq!(sub, vec!["a", "b", "c"]);
        // A pre-existing cycle must terminate rather than hang the walk.
        let cyclic = edges(&[("x", Some("y")), ("y", Some("x"))]);
        assert_eq!(folder_subtree(&cyclic, "x").len(), 2);
    }

    #[test]
    fn a_folder_cannot_move_into_its_own_subtree() {
        let e = edges(&[("a", None), ("b", Some("a")), ("c", Some("b"))]);
        // The load-bearing rejection: a → c would orphan a, b and c from the root.
        assert!(folder_move_rejection(&e, "a", Some("c"))
            .unwrap()
            .contains("own subtree"));
        assert!(folder_move_rejection(&e, "a", Some("a")).is_some());
        assert!(folder_move_rejection(&e, "a", Some("nope")).is_some());
        // Legal moves: down into an unrelated branch, and back to the root.
        assert!(folder_move_rejection(&e, "c", Some("a")).is_none());
        assert!(folder_move_rejection(&e, "c", None).is_none());
    }

    #[test]
    fn move_folder_rejects_a_cycle_and_leaves_the_tree_untouched() {
        let db = Database::open_in_memory().unwrap();
        db.create_folder("a", None, "A").unwrap();
        db.create_folder("b", Some("a"), "B").unwrap();
        assert!(db.move_folder("a", Some("b")).is_err());
        let folders = db.list_folders().unwrap();
        let a = folders.iter().find(|f| f.folder_id == "a").unwrap();
        assert_eq!(a.parent_id, None, "the rejected move changed nothing");
        // The legal direction still works.
        db.move_folder("b", None).unwrap();
        let folders = db.list_folders().unwrap();
        assert_eq!(
            folders
                .iter()
                .find(|f| f.folder_id == "b")
                .unwrap()
                .parent_id,
            None
        );
    }

    #[test]
    fn instantiating_a_template_copies_the_body_but_not_sources_or_comments() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_draft(
            "tpl",
            Some("Redline — Bugs/Fixes"),
            Some("/repo/redline"),
            "# Redline — Bugs/Fixes",
            Some(r#"{"type":"doc","content":[]}"#),
        )
        .unwrap();
        db.set_draft_template("tpl", true).unwrap();
        db.add_draft_source("s1", "tpl", "url", None, Some("http://x"), None, None, None)
            .unwrap();
        db.insert_draft_chat_message(&crate::state::DraftChatMessage {
            id: "m1".into(),
            draft_id: "tpl".into(),
            role: "user".into(),
            body: "hi".into(),
            status: "complete".into(),
            created_at: 1,
        })
        .unwrap();

        assert!(db.copy_draft_body("tpl", "copy", None).unwrap());
        let (json, md, project) = db.get_draft_doc("copy").unwrap().unwrap();
        assert_eq!(json.as_deref(), Some(r#"{"type":"doc","content":[]}"#));
        assert_eq!(md, "# Redline — Bugs/Fixes");
        assert_eq!(project.as_deref(), Some("/repo/redline"));
        // A clean document: no sources, no chat thread — and never a template.
        assert!(db.list_draft_sources("copy").unwrap().is_empty());
        assert!(db.load_draft_chat_thread("copy").unwrap().is_empty());
        let drafts = db.list_drafts().unwrap();
        let copy = drafts.iter().find(|d| d.draft_id == "copy").unwrap();
        assert!(!copy.is_template);
        assert_eq!(copy.title.as_deref(), Some("Redline — Bugs/Fixes"));
        let tpl = drafts.iter().find(|d| d.draft_id == "tpl").unwrap();
        assert!(tpl.is_template, "the source keeps its flag");
        // A vanished source is a loud error path, not a silent blank document.
        assert!(!db.copy_draft_body("nope", "copy2", None).unwrap());
    }

    #[test]
    fn touching_a_draft_counts_opens_without_reordering_the_shelf() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_draft("d1", Some("A"), None, "# A", Some("{}")).unwrap();
        let before = db.list_drafts().unwrap()[0].updated_at;
        db.touch_draft("d1").unwrap();
        db.touch_draft("d1").unwrap();
        let row = &db.list_drafts().unwrap()[0];
        assert_eq!(row.open_count, 2);
        assert!(row.last_opened_at.is_some());
        assert_eq!(row.updated_at, before, "opening must not reorder the shelf");
    }

    #[test]
    fn a_markdown_only_write_never_blanks_the_stored_document() {
        // The whole reason `upsert_draft` takes `Option<&str>`: `draft_chat`'s
        // server-side mirror flush must not destroy the only copy of the doc.
        let db = Database::open_in_memory().unwrap();
        db.upsert_draft("d1", Some("T"), None, "# T", Some(r#"{"type":"doc"}"#))
            .unwrap();
        db.upsert_draft("d1", Some("T"), None, "# T changed", None)
            .unwrap();
        let (json, md, _) = db.get_draft_doc("d1").unwrap().unwrap();
        assert_eq!(json.as_deref(), Some(r#"{"type":"doc"}"#));
        assert_eq!(md, "# T changed");
    }

    #[test]
    fn deleting_a_document_takes_its_sources_comments_and_thread() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_draft("d1", Some("T"), None, "# T", Some("{}"))
            .unwrap();
        db.add_draft_source("s1", "d1", "url", None, Some("http://x"), None, None, None)
            .unwrap();
        db.insert_draft_chat_message(&crate::state::DraftChatMessage {
            id: "m1".into(),
            draft_id: "d1".into(),
            role: "user".into(),
            body: "hi".into(),
            status: "complete".into(),
            created_at: 1,
        })
        .unwrap();
        let impact = db.draft_delete_impact("d1").unwrap();
        assert_eq!(impact.drafts, 1);
        assert_eq!(impact.sources, 1);
        assert_eq!(impact.chat_messages, 1);

        db.delete_draft("d1").unwrap();
        assert!(db.get_draft_doc("d1").unwrap().is_none());
        assert!(db.list_draft_sources("d1").unwrap().is_empty());
        assert!(db.load_draft_chat_thread("d1").unwrap().is_empty());
    }

    #[test]
    fn the_migration_flag_lives_in_the_db_so_it_runs_exactly_once() {
        // A localStorage-resident flag would re-run after a cache clear — on a
        // shelf whose rows have since moved on, that would overwrite real work.
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_setting("redline.bookshelf.migrated").is_none());
        db.upsert_draft("d1", Some("T"), None, "# T", None).unwrap();
        db.upsert_draft("d1", Some("T"), None, "# T", Some(r#"{"a":1}"#))
            .unwrap();
        db.set_setting("redline.bookshelf.migrated", "1").unwrap();
        assert_eq!(
            db.get_setting("redline.bookshelf.migrated").as_deref(),
            Some("1")
        );
        let (json, md, _) = db.get_draft_doc("d1").unwrap().unwrap();
        assert_eq!(json.as_deref(), Some(r#"{"a":1}"#));
        assert_eq!(md, "# T", "the mirror survives the migration untouched");
    }

    #[test]
    fn deleting_a_folder_takes_its_whole_subtree_of_documents() {
        let db = Database::open_in_memory().unwrap();
        db.create_folder("f1", None, "Shelf").unwrap();
        db.create_folder("f2", Some("f1"), "Nested").unwrap();
        db.upsert_draft("d1", Some("A"), None, "", Some("{}")).unwrap();
        db.upsert_draft("d2", Some("B"), None, "", Some("{}")).unwrap();
        db.upsert_draft("d3", Some("C"), None, "", Some("{}")).unwrap();
        db.move_draft("d1", Some("f1")).unwrap();
        db.move_draft("d2", Some("f2")).unwrap();
        // d3 stays at the shelf root and must survive.
        let impact = db.folder_delete_impact("f1").unwrap();
        assert_eq!(impact.folders, 2);
        assert_eq!(impact.drafts, 2);

        let gone = db.delete_folder("f1").unwrap();
        assert_eq!(gone.len(), 2);
        let left = db.list_drafts().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].draft_id, "d3");
        assert!(db.list_folders().unwrap().is_empty());
    }
}
