// SPDX-License-Identifier: Apache-2.0
//! Page-scoped action serialization and observable acknowledgements.
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Operation {
    Navigate { url: String },
    Click { selector: String },
    Fill { selector: String, value: String },
    Key { key: String, selector: Option<String> },
    Scroll { x: f64, y: f64, selector: Option<String> },
    Select { selector: String, value: String },
    Wait { selector: String, text: Option<String>, visible: Option<bool> },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub operation_id: String,
    pub label: String,
    pub expected_revision: Option<String>,
    pub timeout_ms: Option<u64>,
    pub operation: Operation,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub operation_id: String,
    pub label: String,
    pub status: String,
    pub elapsed_ms: u64,
    pub observed: Value,
    pub error: Option<String>,
}
struct PageQueue {
    serial: tokio::sync::Mutex<()>,
    results: Mutex<VecDeque<(String, String, ActionResult)>>,
    interrupted: AtomicU64,
}
static QUEUES: OnceLock<Mutex<HashMap<String, Arc<PageQueue>>>> = OnceLock::new();
fn page_queue(label: &str) -> Arc<PageQueue> {
    QUEUES.get_or_init(Default::default).lock().unwrap().entry(label.to_owned()).or_insert_with(|| Arc::new(PageQueue { serial: tokio::sync::Mutex::new(()), results: Mutex::new(VecDeque::new()), interrupted: AtomicU64::new(0) })).clone()
}
pub fn is_busy(label: &str) -> bool {
    QUEUES.get_or_init(Default::default).lock().unwrap().get(label).is_some_and(|queue| queue.serial.try_lock().is_err())
}
fn observation_script() -> &'static str {
    "JSON.stringify({url:location.href,documentId:String(performance.timeOrigin),revision:window.__redline_revision?window.__redline_revision():String(performance.timeOrigin),ready:document.readyState})"
}
fn navigation_completed(before: &Value, after: &Value, requested: &str) -> bool {
    if !matches!(after["ready"].as_str(), Some("interactive" | "complete")) { return false; }
    let new_document = after["documentId"].is_string() && before["documentId"] != after["documentId"];
    let same_document_navigation = before["url"].as_str() != Some(requested) && after["url"].as_str() == Some(requested);
    new_document || same_document_navigation
}
pub fn operation_script(op: &Operation) -> Result<String, String> {
    let spec = serde_json::to_string(op).map_err(|e| e.to_string())?;
    if spec.len() > 32_000 { return Err("Browser action exceeds the input limit".into()); }
    Ok(format!("{}({spec})", include_str!("browser_action.js")))
}
pub async fn execute(app: tauri::AppHandle, request: ActionRequest) -> Result<ActionResult, String> {
    if request.operation_id.is_empty() || request.operation_id.len() > 128 || !request.label.starts_with("browser-") || request.label.len() > 160 { return Err("An operation ID and stable browser target are required".into()); }
    let serialized = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    if serialized.len() > 34_000 { return Err("Browser action exceeds the input limit".into()); }
    operation_script(&request.operation)?;
    let queue = page_queue(&request.label);
    let queue_revision = queue.interrupted.load(Ordering::SeqCst);
    let input_revision = crate::browser_events::input_revision(&request.label);
    let start = Instant::now();
    let mut result = ActionResult { operation_id: request.operation_id.clone(), label: request.label.clone(), status: "accepted".into(), elapsed_ms: 0, observed: Value::Null, error: None };
    let _ = app.emit("browser-action", &result);
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(5000).clamp(100, 30_000));
    let deadline = tokio::time::Instant::now() + timeout;
    let _guard = match tokio::time::timeout_at(deadline, queue.serial.lock()).await {
        Ok(guard) => guard,
        Err(_) => {
            result.status = "interrupted".into();
            result.elapsed_ms = start.elapsed().as_millis() as u64;
            result.error = Some("Timed out waiting for the page action queue; this request did not run.".into());
            let _ = app.emit("browser-action", &result);
            return Ok(result);
        }
    };
    if let Some((_, previous, outcome)) = queue.results.lock().unwrap().iter().find(|(id, _, _)| id == &request.operation_id) {
        if previous == &serialized {
            let _ = app.emit("browser-action", outcome);
            return Ok(outcome.clone());
        }
        result.status = "failed".into();
        result.error = Some("This operation ID was already used for a different action".into());
        result.elapsed_ms = start.elapsed().as_millis() as u64;
        let _ = app.emit("browser-action", &result);
        return Ok(result);
    }
    result.status = "running".into();
    let _ = app.emit("browser-action", &result);
    let task = async {
        if queue.interrupted.load(Ordering::SeqCst) != queue_revision { return Err("Interrupted because an earlier page action had no confirmed outcome; inspect the page before continuing".to_owned()); }
        if crate::browser_events::input_revision(&request.label) != input_revision { return Err("Interrupted by user interaction".to_owned()); }
        let before: Value = serde_json::from_str(&crate::daemon_eval(&app, &request.label, observation_script()).await?).map_err(|e| e.to_string())?;
        if crate::browser_events::input_revision(&request.label) != input_revision { return Err("Interrupted by user interaction".to_owned()); }
        if request.expected_revision.as_ref().is_some_and(|rev| before["revision"].as_str() != Some(rev.as_str())) { return Err("The page changed since the target was captured; inspect it again".into()); }
        if let Operation::Navigate { url } = &request.operation {
            let parsed: tauri::Url = url.parse().map_err(|_| "Invalid URL".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https") { return Err("Navigation requires an HTTP(S) URL".into()); }
            let requested = parsed.to_string();
            app.get_webview(&request.label).ok_or("Page is closed")?.navigate(parsed).map_err(|e| e.to_string())?;
            loop {
                if crate::browser_events::input_revision(&request.label) != input_revision { return Err("Interrupted by user interaction".into()); }
                let after: Value = serde_json::from_str(&crate::daemon_eval(&app, &request.label, observation_script()).await?).map_err(|e| e.to_string())?;
                if crate::browser_events::input_revision(&request.label) != input_revision { return Err("Interrupted by user interaction".into()); }
                if navigation_completed(&before, &after, &requested) { return Ok(after); }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }
        let script = operation_script(&request.operation)?;
        loop {
            if crate::browser_events::input_revision(&request.label) != input_revision { return Err("Interrupted by user interaction".into()); }
            let observed: Value = serde_json::from_str(&crate::daemon_eval(&app, &request.label, &script).await?).map_err(|e| e.to_string())?;
            if crate::browser_events::input_revision(&request.label) != input_revision { return Err("Interrupted by user interaction; inspect the page before retrying a side effect".into()); }
            if matches!(request.operation, Operation::Wait { .. }) {
                if observed["ok"] == false { return Err(observed["error"].as_str().unwrap_or("Page condition failed").to_owned()); }
                if observed["ready"] == true { return Ok(observed); }
                tokio::time::sleep(Duration::from_millis(40)).await;
            } else if observed["ok"] == true { return Ok(observed); }
            else { return Err(observed["error"].as_str().unwrap_or("Page action failed").to_owned()); }
        }
    };
    match tokio::time::timeout_at(deadline, task).await {
        Ok(Ok(observed)) => { result.status = "completed".into(); result.observed = observed; }
        Ok(Err(error)) => { result.status = if error.starts_with("Interrupted") { "interrupted" } else { "failed" }.into(); result.error = Some(error); }
        Err(_) => { result.status = "interrupted".into(); result.error = Some("No confirmed outcome before the timeout. Inspect the page before retrying a side effect.".into()); }
    }
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    if result.status == "interrupted" { queue.interrupted.fetch_add(1, Ordering::SeqCst); }
    { let mut history = queue.results.lock().unwrap(); history.push_back((request.operation_id, serialized, result.clone())); while history.len() > 128 { history.pop_front(); } }
    let _ = app.emit("browser-action", &result);
    drop(_guard);
    crate::browser_workspace::touch(&request.label);
    crate::browser_workspace::trim(&app).await;
    Ok(result)
}
/// Keep transport adapters on one decoder instead of instantiating this tagged
/// action family separately for the Tauri and HTTP deserializers.
#[inline(never)]
pub fn parse_request(value: Value) -> Result<ActionRequest, String> {
    serde_json::from_value(value).map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn browser_action(app: tauri::AppHandle, request: Value) -> Result<ActionResult, String> { execute(app, parse_request(request)?).await }
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn transport_decoder_preserves_typed_actions_and_rejects_invalid_shapes() {
        let request = parse_request(json!({
            "operationId": "fill-name-1", "label": "browser-t-source",
            "expectedRevision": "document:4", "timeoutMs": 2500,
            "operation": { "kind": "fill", "selector": "#name", "value": "Ada" }
        })).unwrap();
        assert_eq!(request.operation_id, "fill-name-1");
        assert_eq!(request.expected_revision.as_deref(), Some("document:4"));
        assert_eq!(request.timeout_ms, Some(2500));
        assert!(matches!(request.operation, Operation::Fill { selector, value } if selector == "#name" && value == "Ada"));
        for operation in [
            json!({ "kind": "fill", "selector": "#name" }),
            json!({ "kind": "eval", "script": "alert(1)" }),
            json!({ "kind": "scroll", "x": "wrong", "y": 0 })
        ] {
            assert!(parse_request(json!({ "operationId": "op", "label": "browser-t-source", "operation": operation })).is_err());
        }
        assert!(parse_request(json!({ "operation": { "kind": "click", "selector": "a" } })).is_err());
    }
    #[test] fn scripts_encode_untrusted_values_as_data() {
        let script = operation_script(&Operation::Fill { selector: "#name".into(), value: "');window.pwned=true;//".into() }).unwrap();
        assert!(script.contains(r#""value":"');window.pwned=true;//""#));
        assert!(script.contains("setter.call(e,op.value)"));
    }
    #[test] fn huge_actions_are_rejected() { assert!(operation_script(&Operation::Click { selector: "a".repeat(40_000) }).is_err()); }
    #[test] fn navigation_needs_a_new_document_or_the_requested_location() {
        let before = json!({"url":"https://example.org/old", "documentId":"1", "revision":"1:0", "ready":"complete"});
        let mut after = before.clone(); after["revision"] = "1:1".into();
        assert!(!navigation_completed(&before, &after, "https://example.org/new"));
        after["url"] = "https://example.org/old#section".into();
        assert!(navigation_completed(&before, &after, "https://example.org/old#section"));
        after["documentId"] = "2".into(); after["url"] = "https://example.org/redirect".into();
        assert!(navigation_completed(&before, &after, "https://example.org/new"));
        after["ready"] = "loading".into();
        assert!(!navigation_completed(&before, &after, "https://example.org/new"));
    }
    #[tokio::test] async fn page_queue_serializes_and_waiting_honors_deadline() {
        let queue = page_queue("browser-test-order");
        let first = queue.serial.lock().await;
        assert!(is_busy("browser-test-order"));
        assert!(tokio::time::timeout(Duration::from_millis(5), queue.serial.lock()).await.is_err());
        drop(first);
        assert!(queue.serial.try_lock().is_ok());
    }
}
