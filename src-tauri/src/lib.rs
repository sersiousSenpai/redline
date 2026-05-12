use axum::{routing::post, Json, Router};
use serde::Serialize;
use serde_json::Value;
use tauri::tray::TrayIconBuilder;

#[derive(Serialize)]
struct HookResponse {
    #[serde(rename = "hookSpecificOutput")]
    hook_specific_output: HookSpecificOutput,
}

#[derive(Serialize)]
struct HookSpecificOutput {
    #[serde(rename = "hookEventName")]
    hook_event_name: &'static str,
    #[serde(rename = "permissionDecision")]
    permission_decision: &'static str,
    #[serde(rename = "permissionDecisionReason")]
    permission_decision_reason: &'static str,
}

async fn handle_plan(Json(payload): Json<Value>) -> Json<HookResponse> {
    let session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let tool_use_id = payload
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let plan_len = payload
        .pointer("/tool_input/plan")
        .and_then(|v| v.as_str())
        .map(|s| s.len())
        .unwrap_or(0);
    tracing::info!(
        session_id = %session_id,
        tool_use_id = %tool_use_id,
        plan_len = plan_len,
        "POST /v1/plan"
    );
    Json(HookResponse {
        hook_specific_output: HookSpecificOutput {
            hook_event_name: "PreToolUse",
            permission_decision: "allow",
            permission_decision_reason: "Redline M1 stub: hardcoded allow.",
        },
    })
}

async fn run_server() {
    let app = Router::new().route("/v1/plan", post(handle_plan));
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
        .setup(|app| {
            tauri::async_runtime::spawn(run_server());

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Redline")
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
