mod db;
mod feedback;
mod hook;
mod parser;
mod resolutions;
mod state;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use axum::{extract::State, routing::post, Json, Router};
use serde::Serialize;
use serde_json::Value;
use tauri::{tray::TrayIconBuilder, AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::db::Database;
use crate::hook::HookStatus;
use crate::state::{
    Comment, NewCommentRequest, ReviewSession, SessionStatus, SessionStore, SessionSummary,
    UpdateCommentRequest,
};

#[derive(Serialize, Clone, Debug)]
struct HookResponse {
    #[serde(rename = "hookSpecificOutput")]
    hook_specific_output: HookSpecificOutput,
}

#[derive(Serialize, Clone, Debug)]
struct HookSpecificOutput {
    #[serde(rename = "hookEventName")]
    hook_event_name: &'static str,
    #[serde(rename = "permissionDecision")]
    permission_decision: &'static str,
    #[serde(rename = "permissionDecisionReason")]
    permission_decision_reason: String,
}

fn allow_response(reason: impl Into<String>) -> HookResponse {
    HookResponse {
        hook_specific_output: HookSpecificOutput {
            hook_event_name: "PreToolUse",
            permission_decision: "allow",
            permission_decision_reason: reason.into(),
        },
    }
}

fn deny_response(reason: impl Into<String>) -> HookResponse {
    HookResponse {
        hook_specific_output: HookSpecificOutput {
            hook_event_name: "PreToolUse",
            permission_decision: "deny",
            permission_decision_reason: reason.into(),
        },
    }
}

#[derive(Clone)]
struct PendingResponses(Arc<StdMutex<HashMap<String, oneshot::Sender<HookResponse>>>>);

impl PendingResponses {
    fn new() -> Self {
        Self(Arc::new(StdMutex::new(HashMap::new())))
    }
    fn register(&self, session_id: &str) -> Option<oneshot::Receiver<HookResponse>> {
        let mut map = self.0.lock().unwrap();
        if map.contains_key(session_id) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        map.insert(session_id.to_string(), tx);
        Some(rx)
    }
    fn take(&self, session_id: &str) -> Option<oneshot::Sender<HookResponse>> {
        self.0.lock().unwrap().remove(session_id)
    }
}

#[derive(Clone)]
struct AppState {
    store: SessionStore,
    app_handle: AppHandle,
    pending: PendingResponses,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanReceivedEvent {
    session_id: String,
    version: u32,
    is_new_session: bool,
    resolutions_attached: usize,
    unmatched_resolution_ids: Vec<String>,
    unresolved_submitted_ids: Vec<String>,
    resolution_parse_error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    session_id: String,
}

fn refresh_tray(app: &AppHandle, store: &SessionStore) {
    let list = store.list();
    let awaiting = list.iter().filter(|s| s.awaiting_review).count();
    let pending: u32 = list
        .iter()
        .filter(|s| s.awaiting_review)
        .map(|s| s.pending_count)
        .sum();
    let tooltip = if awaiting == 0 {
        "Redline".to_string()
    } else if pending == 0 {
        format!(
            "Redline · {awaiting} active session{}",
            if awaiting == 1 { "" } else { "s" }
        )
    } else {
        format!(
            "Redline · {pending} pending comment{} across {awaiting} session{}",
            if pending == 1 { "" } else { "s" },
            if awaiting == 1 { "" } else { "s" }
        )
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

async fn handle_plan(
    State(app_state): State<AppState>,
    Json(payload): Json<Value>,
) -> Json<HookResponse> {
    let session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    let tool_use_id = payload
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    let cwd = payload
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let raw_plan = payload
        .pointer("/tool_input/plan")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let resolution_result = resolutions::extract_resolutions(&raw_plan);
    let sections = parser::parse_plan(&resolution_result.stripped_markdown);
    let section_count = sections.len();

    let session_existed = app_state.store.has_session(&session_id);

    let (attach_report, resolutions_attached) = if session_existed
        && !resolution_result.resolutions.is_empty()
    {
        let next_version = app_state
            .store
            .get(&session_id)
            .map(|s| s.revisions.len() as u32 + 1)
            .unwrap_or(1);
        let report = app_state.store.attach_resolutions(
            &session_id,
            &resolution_result.resolutions,
            next_version,
        );
        (report, resolution_result.resolutions.len())
    } else {
        (Default::default(), 0)
    };

    let upsert = app_state.store.upsert_plan(
        &session_id,
        &cwd,
        resolution_result.stripped_markdown.clone(),
        sections,
    );

    tracing::info!(
        session_id = %session_id,
        tool_use_id = %tool_use_id,
        plan_len = raw_plan.len(),
        sections = section_count,
        version = upsert.version_number,
        new_session = upsert.is_new_session,
        resolutions = resolutions_attached,
        unmatched = attach_report.unmatched_ids.len(),
        unresolved = attach_report.unresolved_submitted_ids.len(),
        parse_error = ?resolution_result.parse_error,
        "POST /v1/plan parsed; blocking for reviewer"
    );

    let event = PlanReceivedEvent {
        session_id: session_id.clone(),
        version: upsert.version_number,
        is_new_session: upsert.is_new_session,
        resolutions_attached,
        unmatched_resolution_ids: attach_report.unmatched_ids,
        unresolved_submitted_ids: attach_report.unresolved_submitted_ids,
        resolution_parse_error: resolution_result.parse_error,
    };
    if let Err(e) = app_state.app_handle.emit("plan-received", event) {
        tracing::warn!(error = %e, "failed to emit plan-received");
    }
    refresh_tray(&app_state.app_handle, &app_state.store);

    let Some(rx) = app_state.pending.register(&session_id) else {
        tracing::warn!(session_id = %session_id, "duplicate POST while review pending — returning deny");
        return Json(deny_response(
            "A review of an earlier plan from this session is still in progress in Redline. \
             Wait for the reviewer to finish before submitting a new plan.",
        ));
    };

    let response = match rx.await {
        Ok(r) => r,
        Err(_) => {
            tracing::info!(session_id = %session_id, "review channel closed without explicit decision");
            deny_response(
                "User cancelled the review and does not want to proceed with this plan.",
            )
        }
    };

    Json(response)
}

async fn run_server(state: AppState) {
    let app = Router::new()
        .route("/v1/plan", post(handle_plan))
        .with_state(state);
    match tokio::net::TcpListener::bind("127.0.0.1:7676").await {
        Ok(listener) => {
            tracing::info!("Redline daemon listening on http://127.0.0.1:7676");
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(error = %e, "axum::serve exited");
            }
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to bind 127.0.0.1:7676");
        }
    }
}

#[tauri::command]
fn list_sessions(store: tauri::State<'_, SessionStore>) -> Vec<SessionSummary> {
    store.list()
}

#[tauri::command]
fn get_session(store: tauri::State<'_, SessionStore>, id: String) -> Option<ReviewSession> {
    store.get(&id)
}

#[tauri::command]
fn add_comment(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    request: NewCommentRequest,
) -> Result<Comment, String> {
    let result = store
        .add_comment(&session_id, request)
        .ok_or_else(|| format!("no session found for id {session_id}"))?;
    let _ = app.emit(
        "comments-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(result)
}

#[tauri::command]
fn update_comment(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
    update: UpdateCommentRequest,
) -> Result<Comment, String> {
    let result = store
        .update_comment(&session_id, &comment_id, update)
        .ok_or_else(|| format!("no comment {comment_id} in session {session_id}"))?;
    let _ = app.emit(
        "comments-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(result)
}

#[tauri::command]
fn delete_comment(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
) -> Result<bool, String> {
    let removed = store.delete_comment(&session_id, &comment_id);
    if removed {
        let _ = app.emit(
            "comments-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        refresh_tray(&app, &store);
    }
    Ok(removed)
}

#[tauri::command]
fn submit_review(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    session_id: String,
) -> Result<(), String> {
    let Some((sections, comments)) = store.drafts_and_reopens_for_payload(&session_id) else {
        return Err(format!("session not found: {session_id}"));
    };
    if comments.is_empty() {
        return Err(
            "no draft or reopened comments to submit — add at least one or approve instead"
                .to_string(),
        );
    }

    let payload = feedback::serialize_feedback_payload(&sections, &comments);
    let submitted = store.mark_submitted(&session_id);
    tracing::info!(session_id = %session_id, count = submitted.len(), "submit_review fired");

    let tx = pending
        .take(&session_id)
        .ok_or_else(|| "no plan is currently waiting for review on this session".to_string())?;
    let _ = tx.send(deny_response(payload));

    let _ = app.emit(
        "comments-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(())
}

#[tauri::command]
fn approve_plan(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    session_id: String,
) -> Result<(), String> {
    let tx = pending
        .take(&session_id)
        .ok_or_else(|| "no plan is currently waiting for review on this session".to_string())?;
    store.set_status(&session_id, SessionStatus::Approved);
    let _ = tx.send(allow_response("Reviewer approved via Redline."));
    tracing::info!(session_id = %session_id, "approve_plan fired");
    let _ = app.emit(
        "session-status-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(())
}

#[tauri::command]
fn accept_resolution(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
) -> Result<bool, String> {
    let ok = store.accept_resolution(&session_id, &comment_id);
    if ok {
        let _ = app.emit(
            "comments-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        refresh_tray(&app, &store);
    }
    Ok(ok)
}

#[tauri::command]
fn reopen_resolution(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
) -> Result<bool, String> {
    let ok = store.reopen_resolution(&session_id, &comment_id);
    if ok {
        let _ = app.emit(
            "comments-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        refresh_tray(&app, &store);
    }
    Ok(ok)
}

#[tauri::command]
fn get_hook_status() -> HookStatus {
    hook::get_status()
}

#[tauri::command]
fn install_hook() -> Result<HookStatus, String> {
    let result = hook::install();
    if let Ok(status) = &result {
        tracing::info!(path = %status.settings_path, "installed redline hook");
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".parse().unwrap()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            get_session,
            add_comment,
            update_comment,
            delete_comment,
            submit_review,
            approve_plan,
            accept_resolution,
            reopen_resolution,
            get_hook_status,
            install_hook,
        ])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve app data dir");
            let db_path = data_dir.join("redline.db");
            tracing::info!(path = %db_path.display(), "opening sqlite database");
            let db = Arc::new(
                Database::open(&db_path).expect("failed to open sqlite database"),
            );

            let store = SessionStore::new(db);
            app.manage(store.clone());

            let pending = PendingResponses::new();
            app.manage(pending.clone());

            let app_state = AppState {
                store: store.clone(),
                app_handle: app.handle().clone(),
                pending,
            };
            tauri::async_runtime::spawn(run_server(app_state));

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Redline")
                .build(app)?;

            refresh_tray(app.handle(), &store);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
