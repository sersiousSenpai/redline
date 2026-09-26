// SPDX-License-Identifier: Apache-2.0
//! SQLite workspace records outlive both the page dock and native webviews.
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use crate::db::Database;
use std::{collections::{HashSet, VecDeque}, sync::{Mutex, OnceLock}};
/// A mosaic is a 4×4 grid at most, and every tile on screen stays live.
pub const MAX_MOSAIC_TILES: usize = 16;
/// Mosaic workspaces are rows of this table whose id carries this prefix.
pub const MOSAIC_PREFIX: &str = "mosaic:";
/// A mosaic's definition. Its editor writes these; the pane's periodic
/// tab/layout saves never carry them and must not erase them.
const DEFINITION_KEYS: [&str; 3] = ["name", "grid", "cells"];
static VISIBLE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static RECENT: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
pub fn protected(label: &str) -> bool { VISIBLE.get_or_init(Default::default).lock().unwrap().contains(label) }
pub fn touch(label: &str) {
    let mut recent = RECENT.get_or_init(Default::default).lock().unwrap();
    recent.retain(|other| other != label); recent.push_front(label.into());
    while recent.len() > 400 { recent.pop_back(); }
}
pub async fn trim(app: &tauri::AppHandle) {
    use tauri::Manager;
    let labels = RECENT.get_or_init(Default::default).lock().unwrap().iter().cloned().collect::<Vec<_>>();
    let mut live = labels.iter().filter(|label| app.get_webview(label).is_some()).count();
    // The backstop tracks whatever the pane declared visible, so a mosaic's
    // tiles are never suspended out from under it.
    let floor = 4.max(VISIBLE.get_or_init(Default::default).lock().unwrap().len());
    for label in labels.into_iter().rev() {
        if live <= floor { break; }
        if !protected(&label) && app.get_webview(&label).is_some()
            && crate::browser_can_suspend(app.clone(), label.clone()).await.unwrap_or(false)
            && crate::browser_suspend(app.clone(), label).await.is_ok() { live -= 1; }
    }
}
#[tauri::command]
pub async fn browser_protect_tabs(app: tauri::AppHandle, labels: Vec<String>) -> Result<(), String> {
    if labels.len() > MAX_MOSAIC_TILES || labels.iter().any(|label| !label.starts_with("browser-") || label.len() > 160) { return Err("Invalid visible tiles".into()); }
    *VISIBLE.get_or_init(Default::default).lock().unwrap() = labels.iter().cloned().collect();
    for label in labels { touch(&label); }
    trim(&app).await;
    Ok(())
}
fn initialize(db: &Database) -> Result<(), String> {
    db.lock_conn().execute_batch("CREATE TABLE IF NOT EXISTS browser_workspaces(id TEXT PRIMARY KEY,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)").map_err(|e| e.to_string())
}
pub fn read(db: &Database, id: &str) -> Result<Option<Value>, String> {
    initialize(db)?;
    let row: Option<(String, i64)> = db.lock_conn().query_row("SELECT body,revision FROM browser_workspaces WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    row.map(|(body, revision)| { let mut value: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?; value["revision"] = revision.into(); Ok(value) }).transpose()
}
pub fn tabs(db: &Database, workspace: &str) -> Result<Vec<Value>, String> {
    let saved = read(db, workspace)?;
    if let Some(array) = saved.as_ref().and_then(|value| value["tabs"].as_array()) { return Ok(array.clone()); }
    if workspace == "regular" { return Ok(vec![]); }
    let connection = db.lock_conn();
    let raw: Option<String> = connection.query_row("SELECT tabs_json FROM missions WHERE mission_id=?1", [workspace], |r| r.get(0)).optional().map_err(|e| e.to_string())?.flatten();
    raw.map(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string())).transpose().map(Option::unwrap_or_default)
}
pub fn find_tab(db: &Database, label: &str) -> Result<Option<Value>, String> {
    initialize(db)?;
    let id = label.strip_prefix("browser-").ok_or("Invalid browser label")?;
    let bodies = {
        let connection = db.lock_conn();
        let mut query = connection.prepare("SELECT body FROM browser_workspaces UNION ALL SELECT json_object('tabs',json(tabs_json)) FROM missions WHERE tabs_json IS NOT NULL").map_err(|e| e.to_string())?;
        let results = query.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
        results
    };
    for raw in bodies {
        let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if let Some(tabs) = value["tabs"].as_array() {
            for tab in tabs {
                let canonical = tab["browseId"].as_str().map(|browse| format!("t-{browse}"));
                if canonical.as_deref() == Some(id) || tab["id"].as_str() == Some(id) {
                    let mut tab = tab.clone(); tab["id"] = id.into(); tab["label"] = label.into(); return Ok(Some(tab));
                }
            }
        }
    }
    Ok(None)
}
pub fn write(db: &Database, id: &str, mut value: Value, expected_revision: Option<i64>) -> Result<Value, String> {
    initialize(db)?;
    if id.is_empty() || id.len() > 160 || !value.is_object() { return Err("Invalid workspace".into()); }
    let tabs = value["tabs"].as_array().ok_or("Workspace tabs are missing")?;
    if tabs.len() > 100 { return Err("A workspace can contain at most 100 tabs".into()); }
    let mut ids = std::collections::HashSet::new();
    for tab in tabs {
        let id = tab["id"].as_str().ok_or("Tab identity is missing")?;
        let url = tab["url"].as_str().ok_or("Tab URL is missing")?;
        let valid_url = url == "about:blank" || tauri::Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some());
        if id.is_empty() || !ids.insert(id) || id.len() > 160 || url.len() > 8192 || !valid_url { return Err("Invalid or duplicate tab in workspace".into()); }
    }
    if value.get("name").is_some_and(|name| !name.as_str().is_some_and(|name| name.len() <= 200)) { return Err("Invalid workspace name".into()); }
    if value.get("cells").is_some_and(|cells| !cells.as_array().is_some_and(|cells| cells.len() <= MAX_MOSAIC_TILES)) { return Err("A mosaic can contain at most 16 pages".into()); }
    value.as_object_mut().unwrap().remove("revision");
    let mut connection = db.lock_conn();
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    let prior: Option<(i64, String)> = tx.query_row("SELECT revision,body FROM browser_workspaces WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    let prior_revision = prior.as_ref().map_or(0, |(revision, _)| *revision);
    if expected_revision.is_some_and(|expected| expected != prior_revision) { return Err("This workspace changed during the operation; reload it before saving".into()); }
    if let Some(previous) = prior.and_then(|(_, body)| serde_json::from_str::<Value>(&body).ok()) {
        for key in DEFINITION_KEYS {
            if value.get(key).is_none() { if let Some(kept) = previous.get(key) { value[key] = kept.clone(); } }
        }
    }
    let body = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    if body.len() > 1_048_576 { return Err("Workspace exceeds the storage bound".into()); }
    let revision = prior_revision + 1;
    tx.execute("INSERT INTO browser_workspaces(id,body,revision,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision,updated_at=excluded.updated_at", params![id,body,revision,crate::now_millis()]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    value["revision"] = revision.into();
    Ok(value)
}
/// Summaries of the workspaces whose id starts with `prefix`, most recently used first.
pub fn list(db: &Database, prefix: &str) -> Result<Vec<Value>, String> {
    initialize(db)?;
    if prefix.is_empty() || prefix.len() > 160 { return Err("Invalid workspace prefix".into()); }
    let rows = {
        let connection = db.lock_conn();
        let mut query = connection.prepare("SELECT id,body,updated_at FROM browser_workspaces WHERE substr(id,1,length(?1))=?1 ORDER BY updated_at DESC").map_err(|e| e.to_string())?;
        let rows = query.query_map([prefix], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
        rows
    };
    Ok(rows.into_iter().map(|(id, body, updated_at)| {
        let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let grid = if value["grid"].is_object() { value["grid"].clone() } else { value["layout"]["grid"].clone() };
        let pages = value["cells"].as_array().or(value["tabs"].as_array()).map_or(0, Vec::len);
        serde_json::json!({ "id": id, "name": value["name"], "grid": grid, "tabCount": pages, "updatedAt": updated_at })
    }).collect())
}
/// Deletes a saved mosaic. Missions and regular browsing have their own lifecycles.
pub fn delete(db: &Database, id: &str) -> Result<(), String> {
    initialize(db)?;
    if !id.starts_with(MOSAIC_PREFIX) || id.len() > 160 { return Err("Only a saved mosaic can be deleted".into()); }
    db.lock_conn().execute("DELETE FROM browser_workspaces WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command(async)]
pub fn browser_workspace_list(store: tauri::State<'_, crate::state::SessionStore>, prefix: String) -> Result<Vec<Value>, String> { list(&store.database(), &prefix) }
#[tauri::command(async)]
pub fn browser_workspace_delete(store: tauri::State<'_, crate::state::SessionStore>, workspace_id: String) -> Result<(), String> { delete(&store.database(), &workspace_id) }
#[tauri::command(async)]
pub fn browser_workspace_read(store: tauri::State<'_, crate::state::SessionStore>, workspace_id: String) -> Result<Option<Value>, String> { read(&store.database(), &workspace_id) }
#[tauri::command(async)]
pub fn browser_workspace_write(store: tauri::State<'_, crate::state::SessionStore>, workspace_id: String, value: Value, expected_revision: Option<i64>) -> Result<Value, String> { write(&store.database(), &workspace_id, value, expected_revision) }
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn stale_saves_do_not_overwrite_another_workspace_revision() {
        let db = Database::open_in_memory().unwrap();
        let value = json!({"tabs":[{"id":"a","url":"https://example.org"}],"layout":{"preset":"compare"}});
        write(&db, "regular", value.clone(), Some(0)).unwrap();
        assert!(write(&db, "regular", json!({"tabs":[]}), Some(0)).is_err());
        assert_eq!(read(&db, "regular").unwrap().unwrap()["tabs"], value["tabs"]);
        assert!(read(&db, "different").unwrap().is_none());
        assert!(write(&db, "regular", json!({"tabs":[{"id":"","url":"https://example.org"}]}), Some(1)).is_err());
        assert!(write(&db, "regular", json!({"tabs":[{"id":"a","url":"https://"}]}), Some(1)).is_err());
    }
    #[test] fn mosaics_list_by_prefix_keep_their_definition_and_delete_alone() {
        let db = Database::open_in_memory().unwrap();
        let cells = json!([{"browseId":"a","url":"https://a.example","label":"A"}]);
        write(&db, "mosaic:one", json!({"name":"Stock News","grid":{"rows":3,"cols":3},"cells":cells,"tabs":[{"id":"t-a","url":"https://a.example"}],"layout":{"preset":"grid","grid":{"rows":3,"cols":3}}}), Some(0)).unwrap();
        write(&db, "regular", json!({"tabs":[{"id":"t-r","url":"https://r.example"}]}), Some(0)).unwrap();
        write(&db, "mission-1", json!({"tabs":[]}), Some(0)).unwrap();
        // A periodic tab/layout save carries no definition and must not erase it.
        write(&db, "mosaic:one", json!({"tabs":[{"id":"t-a","url":"https://a.example/today"}],"layout":{"preset":"grid"}}), Some(1)).unwrap();
        let saved = read(&db, "mosaic:one").unwrap().unwrap();
        assert_eq!(saved["name"], "Stock News");
        assert_eq!(saved["cells"], cells);
        assert_eq!(saved["tabs"][0]["url"], "https://a.example/today");
        let listed = list(&db, MOSAIC_PREFIX).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["id"], "mosaic:one");
        assert_eq!(listed[0]["name"], "Stock News");
        assert_eq!(listed[0]["grid"], json!({"rows":3,"cols":3}));
        assert_eq!(listed[0]["tabCount"], 1);
        assert!(list(&db, "").is_err());
        assert!(write(&db, "mosaic:two", json!({"name":"x","cells":vec![json!({}); 17],"tabs":[]}), Some(0)).is_err());
        assert!(delete(&db, "regular").is_err());
        assert!(delete(&db, "mission-1").is_err());
        delete(&db, "mosaic:one").unwrap();
        assert!(read(&db, "mosaic:one").unwrap().is_none());
        assert!(list(&db, MOSAIC_PREFIX).unwrap().is_empty());
        assert!(read(&db, "regular").unwrap().is_some());
    }
}
