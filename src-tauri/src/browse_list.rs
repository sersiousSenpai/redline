// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

//! A browser tab's **working list** — the punch list a user builds while
//! clicking around their own dev server on `localhost`, then hands to Claude
//! Code or the Drafter in one piece.
//!
//! Thin CRUD, deliberately. There is no agent here, nothing spawns, nothing
//! streams: the tab's page-discussion agent (browse.rs) is already the right
//! colleague for a question about the running page, and §1e routes "discuss
//! this item" straight into it rather than growing a second one.
//!
//! Modelled on `mission.rs`'s findings commands, minus the ledger write. A
//! pinned finding is a *curation decision* and belongs in the lake; a list item
//! is a private note the user will edit and delete freely, and recording each
//! keystroke as a decision would drown the signal it is meant to carry.
//!
//! The **template** (which sections a list shows) is frontend data, not schema
//! — see `src/lib/browseList.ts`. Adding a template must never require a
//! migration here, so `template` is stored and returned as an opaque string.

use std::sync::Arc;

use crate::db::Database;
use crate::state::{now_millis, BrowseList, BrowseListItem, BrowseListView};

pub struct BrowseListState {
    pub db: Arc<Database>,
}

impl BrowseListState {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }
}

/// The whole list in one call. `None` means this tab has no list yet, which is
/// what puts the panel on the template chooser — distinct from a list whose
/// items the user has emptied, which stays a list.
#[tauri::command]
pub fn browse_list_get(
    state: tauri::State<'_, BrowseListState>,
    browse_id: String,
) -> Result<Option<BrowseListView>, String> {
    let Some(list) = state
        .db
        .get_browse_list(&browse_id)
        .map_err(|e| format!("failed to load list: {e}"))?
    else {
        return Ok(None);
    };
    let items = state
        .db
        .list_browse_list_items(&browse_id)
        .map_err(|e| format!("failed to load list items: {e}"))?;
    Ok(Some(BrowseListView { list, items }))
}

/// Create the list, or re-point an existing one at another template.
///
/// Idempotent by design: the panel calls this on every template pick, and
/// picking the same one twice must not duplicate or reset anything. The upsert
/// keeps `created_at` and the items, because switching template is an edit of
/// the same list — a template only decides which chips are offered.
#[tauri::command]
pub fn browse_list_start(
    state: tauri::State<'_, BrowseListState>,
    browse_id: String,
    template: String,
    title: Option<String>,
) -> Result<BrowseListView, String> {
    let template = template.trim();
    if template.is_empty() {
        return Err("a list needs a template".to_string());
    }
    let now = now_millis();
    let existing = state
        .db
        .get_browse_list(&browse_id)
        .map_err(|e| format!("failed to load list: {e}"))?;
    let list = BrowseList {
        browse_id: browse_id.clone(),
        template: template.to_string(),
        title: title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            // A retitle to nothing keeps the old title rather than blanking it:
            // the chooser doesn't collect one, and it re-runs on every pick.
            .or_else(|| existing.as_ref().and_then(|l| l.title.clone())),
        created_at: existing.as_ref().map(|l| l.created_at).unwrap_or(now),
        updated_at: now,
    };
    state
        .db
        .upsert_browse_list(&list)
        .map_err(|e| format!("failed to start list: {e}"))?;
    let items = state
        .db
        .list_browse_list_items(&browse_id)
        .map_err(|e| format!("failed to load list items: {e}"))?;
    Ok(BrowseListView { list, items })
}

/// Append one item and hand the row back, so the panel renders the real record
/// (id and sort index included) rather than an optimistic guess it would then
/// have to reconcile.
#[tauri::command]
pub fn browse_list_add(
    state: tauri::State<'_, BrowseListState>,
    browse_id: String,
    kind: String,
    body: String,
) -> Result<BrowseListItem, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("nothing to add".to_string());
    }
    // An item may only exist under a list. Without this an "＋ Add as item" on a
    // tab whose list was cleared would write an orphan row that nothing renders.
    if state
        .db
        .get_browse_list(&browse_id)
        .map_err(|e| format!("failed to load list: {e}"))?
        .is_none()
    {
        return Err("this tab has no list yet".to_string());
    }
    let now = now_millis();
    let it = BrowseListItem {
        id: uuid::Uuid::new_v4().to_string(),
        browse_id: browse_id.clone(),
        kind: kind.trim().to_string(),
        body: body.to_string(),
        done: false,
        sort_idx: state
            .db
            .next_browse_list_sort(&browse_id)
            .map_err(|e| format!("failed to place item: {e}"))?,
        created_at: now,
        updated_at: now,
    };
    state
        .db
        .insert_browse_list_item(&it)
        .map_err(|e| format!("failed to add item: {e}"))?;
    touch(&state, &browse_id, now);
    Ok(it)
}

/// A partial edit — body, kind and done are each optional, and an omitted field
/// is left alone. Read-modify-write rather than a built SQL fragment: three
/// nullable columns is exactly the size where hand-built SQL starts silently
/// blanking whatever the caller didn't mention.
#[tauri::command]
pub fn browse_list_update(
    state: tauri::State<'_, BrowseListState>,
    id: String,
    body: Option<String>,
    kind: Option<String>,
    done: Option<bool>,
) -> Result<BrowseListItem, String> {
    let mut it = state
        .db
        .get_browse_list_item(&id)
        .map_err(|e| format!("failed to load item: {e}"))?
        .ok_or_else(|| "that item is gone".to_string())?;
    if let Some(b) = body {
        let b = b.trim();
        // An edit to nothing is a delete the user didn't ask for. Keep the text
        // and let `browse_list_remove` be the way an item goes away.
        if !b.is_empty() {
            it.body = b.to_string();
        }
    }
    if let Some(k) = kind {
        let k = k.trim();
        if !k.is_empty() {
            it.kind = k.to_string();
        }
    }
    if let Some(d) = done {
        it.done = d;
    }
    it.updated_at = now_millis();
    state
        .db
        .update_browse_list_item(&it)
        .map_err(|e| format!("failed to save item: {e}"))?;
    touch(&state, &it.browse_id, it.updated_at);
    Ok(it)
}

#[tauri::command]
pub fn browse_list_remove(
    state: tauri::State<'_, BrowseListState>,
    id: String,
) -> Result<(), String> {
    let owner = state
        .db
        .get_browse_list_item(&id)
        .map_err(|e| format!("failed to load item: {e}"))?
        .map(|it| it.browse_id);
    state
        .db
        .delete_browse_list_item(&id)
        .map_err(|e| format!("failed to remove item: {e}"))?;
    if let Some(b) = owner {
        touch(&state, &b, now_millis());
    }
    Ok(())
}

/// Rewrite the order from the ids given. The whole order, not a move: a drag
/// produces the list the user now sees, and reconciling a from/to pair against
/// concurrent adds is a race this doesn't need to have.
#[tauri::command]
pub fn browse_list_reorder(
    state: tauri::State<'_, BrowseListState>,
    browse_id: String,
    ids: Vec<String>,
) -> Result<Vec<BrowseListItem>, String> {
    state
        .db
        .reorder_browse_list(&browse_id, &ids)
        .map_err(|e| format!("failed to reorder: {e}"))?;
    touch(&state, &browse_id, now_millis());
    state
        .db
        .list_browse_list_items(&browse_id)
        .map_err(|e| format!("failed to load list items: {e}"))
}

/// Drop the list entirely — items and row. Mirrors `browse_discard`: the next
/// open lands back on the template chooser, which is what "clear" should mean
/// for a surface whose empty state is a real choice.
#[tauri::command]
pub fn browse_list_clear(
    state: tauri::State<'_, BrowseListState>,
    browse_id: String,
) -> Result<(), String> {
    state
        .db
        .delete_browse_list(&browse_id)
        .map_err(|e| format!("failed to clear list: {e}"))
}

/// Keep `updated_at` honest on the list row when its items change. Best-effort:
/// a failed timestamp bump must never fail the edit that succeeded.
fn touch(state: &tauri::State<'_, BrowseListState>, browse_id: &str, now: i64) {
    if let Ok(Some(mut l)) = state.db.get_browse_list(browse_id) {
        l.updated_at = now;
        if let Err(e) = state.db.upsert_browse_list(&l) {
            tracing::warn!(error = %e, "failed to touch browse list");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn db() -> Arc<Database> {
        Arc::new(Database::open_in_memory().expect("in-memory db"))
    }

    #[test]
    fn a_list_row_is_what_separates_no_list_from_an_empty_one() {
        let db = db();
        assert!(db.get_browse_list("b1").unwrap().is_none());
        let now = now_millis();
        db.upsert_browse_list(&BrowseList {
            browse_id: "b1".into(),
            template: "punch-list".into(),
            title: None,
            created_at: now,
            updated_at: now,
        })
        .unwrap();
        // A list with zero items still EXISTS — the panel must show the list,
        // not fall back to the chooser it already dismissed.
        let l = db.get_browse_list("b1").unwrap().expect("row");
        assert_eq!(l.template, "punch-list");
        assert!(db.list_browse_list_items("b1").unwrap().is_empty());
    }

    #[test]
    fn appends_land_after_everything_including_after_a_reorder() {
        let db = db();
        let now = now_millis();
        db.upsert_browse_list(&BrowseList {
            browse_id: "b1".into(),
            template: "bugs-fixes-improvements".into(),
            title: None,
            created_at: now,
            updated_at: now,
        })
        .unwrap();
        let mut ids = Vec::new();
        for (i, body) in ["one", "two", "three"].iter().enumerate() {
            let sort = db.next_browse_list_sort("b1").unwrap();
            assert_eq!(sort, i as i64);
            let it = BrowseListItem {
                id: format!("i{i}"),
                browse_id: "b1".into(),
                kind: "bug".into(),
                body: (*body).into(),
                done: false,
                sort_idx: sort,
                created_at: now,
                updated_at: now,
            };
            db.insert_browse_list_item(&it).unwrap();
            ids.push(it.id);
        }
        // Reverse the order, then append: the new item must still be last.
        ids.reverse();
        db.reorder_browse_list("b1", &ids).unwrap();
        let after: Vec<String> = db
            .list_browse_list_items("b1")
            .unwrap()
            .into_iter()
            .map(|i| i.body)
            .collect();
        assert_eq!(after, vec!["three", "two", "one"]);
        assert_eq!(db.next_browse_list_sort("b1").unwrap(), 3);
    }

    #[test]
    fn a_reorder_cannot_reach_another_tabs_item() {
        let db = db();
        let now = now_millis();
        for b in ["b1", "b2"] {
            db.upsert_browse_list(&BrowseList {
                browse_id: b.into(),
                template: "punch-list".into(),
                title: None,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
            db.insert_browse_list_item(&BrowseListItem {
                id: format!("{b}-item"),
                browse_id: b.into(),
                kind: "note".into(),
                body: "x".into(),
                done: false,
                sort_idx: 7,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        }
        // b1 claims b2's item in its order. The WHERE browse_id guard is what
        // stops one tab's drag from renumbering another tab's list.
        db.reorder_browse_list("b1", &["b2-item".to_string(), "b1-item".to_string()])
            .unwrap();
        assert_eq!(
            db.get_browse_list_item("b2-item").unwrap().unwrap().sort_idx,
            7
        );
        assert_eq!(
            db.get_browse_list_item("b1-item").unwrap().unwrap().sort_idx,
            1
        );
    }

    #[test]
    fn clearing_removes_the_row_so_the_chooser_comes_back() {
        let db = db();
        let now = now_millis();
        db.upsert_browse_list(&BrowseList {
            browse_id: "b1".into(),
            template: "punch-list".into(),
            title: None,
            created_at: now,
            updated_at: now,
        })
        .unwrap();
        db.insert_browse_list_item(&BrowseListItem {
            id: "i1".into(),
            browse_id: "b1".into(),
            kind: "note".into(),
            body: "x".into(),
            done: false,
            sort_idx: 0,
            created_at: now,
            updated_at: now,
        })
        .unwrap();
        db.delete_browse_list("b1").unwrap();
        assert!(db.get_browse_list("b1").unwrap().is_none());
        assert!(db.list_browse_list_items("b1").unwrap().is_empty());
    }

    #[test]
    fn switching_template_keeps_the_list_it_is_a_view_over() {
        let db = db();
        let created = 1_000;
        db.upsert_browse_list(&BrowseList {
            browse_id: "b1".into(),
            template: "punch-list".into(),
            title: Some("Dev server".into()),
            created_at: created,
            updated_at: created,
        })
        .unwrap();
        db.insert_browse_list_item(&BrowseListItem {
            id: "i1".into(),
            browse_id: "b1".into(),
            kind: "note".into(),
            body: "keep me".into(),
            done: false,
            sort_idx: 0,
            created_at: created,
            updated_at: created,
        })
        .unwrap();
        let existing = db.get_browse_list("b1").unwrap().unwrap();
        db.upsert_browse_list(&BrowseList {
            browse_id: "b1".into(),
            template: "bugs-fixes-improvements".into(),
            title: existing.title.clone(),
            created_at: existing.created_at,
            updated_at: 2_000,
        })
        .unwrap();
        let l = db.get_browse_list("b1").unwrap().unwrap();
        assert_eq!(l.template, "bugs-fixes-improvements");
        assert_eq!(l.created_at, created, "a template swap is an edit, not a new list");
        assert_eq!(l.title.as_deref(), Some("Dev server"));
        assert_eq!(db.list_browse_list_items("b1").unwrap().len(), 1);
    }
}
