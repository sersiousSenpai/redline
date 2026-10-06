// SPDX-License-Identifier: Apache-2.0
//! A deterministic new-tab feed; one bounded pass over browsing history.
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
#[tauri::command]
pub async fn browser_home_feed(state: tauri::State<'_, crate::browse_list::BrowseListState>, limit: Option<usize>) -> Result<Value, String> {
    let db = state.db.clone(); let limit = limit.unwrap_or(12).clamp(1, 32);
    tokio::task::spawn_blocking(move || feed(&db, limit, crate::now_millis())).await.map_err(|e| e.to_string())?
}
fn feed(db: &crate::db::Database, limit: usize, now: i64) -> Result<Value, String> {
    let connection = db.lock_conn();
    let mut query = connection.prepare("SELECT url,title,ts,shot_key FROM browse_events WHERE action='navigate' ORDER BY ts DESC,id DESC LIMIT 20000").map_err(|e| e.to_string())?;
    let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?,row.get::<_, Option<String>>(1)?,row.get::<_, i64>(2)?,row.get::<_, Option<String>>(3)?))).map_err(|e| e.to_string())?;
    let mut recent: Vec<Value> = Vec::new(); let mut seen = HashSet::new(); let mut hosts: HashMap<String, (f64, Value)> = HashMap::new();
    for row in rows {
        let (url,title,ts,shot_key) = row.map_err(|e| e.to_string())?;
        let Ok(parsed) = tauri::Url::parse(&url) else { continue }; if !matches!(parsed.scheme(), "http"|"https") { continue; }
        let Some(host) = parsed.host_str() else { continue };
        let page = json!({"url":url,"title":title.unwrap_or_else(|| host.to_owned()),"at":ts,"shotKey":shot_key});
        if seen.insert(url.clone()) && recent.len() < limit { recent.push(page.clone()); }
        else if let Some(previous) = recent.iter_mut().find(|previous| previous["url"] == url && previous["shotKey"].is_null()) { previous["shotKey"] = page["shotKey"].clone(); }
        let days = (now-ts).max(0) as f64 / 86_400_000.;
        if days <= 30. { let entry = hosts.entry(host.to_owned()).or_insert((0.,page)); entry.0 += 1. / (1. + days / 7.); }
    }
    let mut frequent: Vec<_> = hosts.into_values().collect(); frequent.sort_by(|a,b| b.0.total_cmp(&a.0).then_with(|| b.1["at"].as_i64().cmp(&a.1["at"].as_i64())).then_with(|| a.1["url"].as_str().cmp(&b.1["url"].as_str())));
    let mut query = connection.prepare("SELECT page_url,MAX(page_title),COUNT(*) FROM browse_list_items WHERE done=0 AND page_url IS NOT NULL AND browse_id LIKE 'cart:%' GROUP BY page_url ORDER BY MAX(updated_at) DESC LIMIT ?1").map_err(|e| e.to_string())?;
    let tasks = query.query_map([limit as i64], |row| Ok(json!({"url":row.get::<_,String>(0)?,"title":row.get::<_,Option<String>>(1)?,"count":row.get::<_,i64>(2)?}))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let mut query = connection.prepare("SELECT mission_id,title FROM missions WHERE status='active' ORDER BY updated_at DESC LIMIT ?1").map_err(|e| e.to_string())?;
    let missions = query.query_map([limit as i64], |row| Ok(json!({"missionId":row.get::<_,String>(0)?,"title":row.get::<_,String>(1)?}))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    Ok(json!({"recent":recent,"frequent":frequent.into_iter().take(limit).map(|(_,page)|page).collect::<Vec<_>>(),"tasks":tasks,"missions":missions}))
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn feed_is_empty_for_a_new_database() { let db = crate::db::Database::open_in_memory().unwrap(); let value = feed(&db, 12, 0).unwrap(); assert_eq!(value["recent"], json!([])); assert_eq!(value["missions"], json!([])); }
    #[test] fn feed_deduplicates_and_keeps_latest_available_shot_and_unfinished_tasks() {
        let db = crate::db::Database::open_in_memory().unwrap();
        for (index,url) in ["https://a.test", "https://b.test", "https://a.test"].iter().enumerate() {
            crate::ledger::record_browse_event(&db, crate::ledger::BrowseEventInput { action: crate::ledger::BrowseAction::Navigate, browse_id: Some(format!("tab-{index}")), url: url.to_string(), title:Some(format!("Page {index}")), text: format!("body {index}"), from_event_id:None,author:None }).unwrap();
        }
        {
            let connection = db.lock_conn();
            connection.execute("UPDATE browse_events SET ts=id*1000,shot_key=CASE WHEN id=1 THEN 'first-shot' ELSE NULL END", []).unwrap();
            for (id,done,key) in [("open",0,"cart:regular"),("done",1,"cart:regular"),("unrelated",0,"other")] {
                connection.execute("INSERT INTO browse_list_items(id,browse_id,kind,body,done,sort_idx,page_url,page_title,created_at,updated_at) VALUES (?1,?2,'note','Task',?3,0,'https://a.test','A',1,1)", rusqlite::params![id,key,done]).unwrap();
            }
        }
        let value = feed(&db,12,4000).unwrap();
        assert_eq!(value["recent"].as_array().unwrap().len(),2);
        assert_eq!(value["recent"][0]["title"],"Page 2");
        assert_eq!(value["recent"][0]["shotKey"],"first-shot");
        assert_eq!(value["frequent"][0]["url"],"https://a.test");
        assert_eq!(value["tasks"][0]["count"],1);
    }
}
