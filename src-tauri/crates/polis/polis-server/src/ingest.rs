// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `POST /v1/prompts/ingest` — the capture hook's sink.
//!
//! Redline's handler, moved verbatim (Session A6), with every host-shaped
//! fork in it asked of the [`IngestObserver`] instead of answered inline: the
//! restore-trigger answer, the agent-seat header, the seat exemption, the
//! launch and orchestration handoffs, the project registry, the external-
//! capture setting, the transcript backfill. What is left is the route's own
//! contract — the size cap, the payload shape, the consume-once agent-prompt
//! guard, the row, and the response bodies the hook and its tests read.
//! Fail-open throughout: nothing here answers anything but 200/201, so prompt
//! submission is never blocked by the memory being closed or slow.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use polis_core::api::CaptureRequest;
use polis_core::host::{Change, IngestContext, IngestHeaders};
use polis_core::ledger::{body_hash, claim_agent_prompt, Origin};

use crate::PolisState;

/// The request's headers as the observer reads them.
pub struct HttpHeaders<'a>(pub &'a HeaderMap);

impl IngestHeaders for HttpHeaders<'_> {
    fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).and_then(|v| v.to_str().ok()).map(str::trim)
    }
}

/// Extract the submitted prompt text from a UserPromptSubmit payload. Empirical:
/// claude 2.1.199 delivers it at `prompt` (verified via the hook rig; see
/// docs/protocol-verification.md). We accept `user_input` too so a future key
/// rename degrades gracefully rather than silently capturing empties.
pub fn ingest_prompt_text(v: &serde_json::Value) -> String {
    v.get("prompt")
        .and_then(serde_json::Value::as_str)
        .or_else(|| v.get("user_input").and_then(serde_json::Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string()
}

/// `POST /v1/prompts/ingest` — the UserPromptSubmit capture hook's sink. Records
/// interactive prompts (PTY plan sessions + external sessions) into the ledger.
/// Fail-open: any error returns 200 so the hook never blocks prompt submission.
pub async fn handle_prompts_ingest(
    State(state): State<PolisState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    // 64KB cap (reject oversized payloads without parsing).
    if body.len() > 64 * 1024 {
        return (StatusCode::OK, Json(serde_json::json!({ "skipped": "too_large" })))
            .into_response();
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return (StatusCode::OK, Json(serde_json::json!({ "skipped": "unparseable" })))
            .into_response();
    };
    let prompt = ingest_prompt_text(&v);
    if prompt.is_empty() {
        return (StatusCode::OK, Json(serde_json::json!({ "skipped": "empty" }))).into_response();
    }
    let claude_session_id = v
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let cwd = v
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    // A headless `claude -p` fires this hook too, so a host's own spawned
    // agents would be double-captured (Rust site + hook). The Rust site is
    // authoritative; it registers the body before spawn, so claim-and-skip here.
    //
    // The header is the primary mechanism and the hash guard is the fallback,
    // not the other way round: the guard can only recognize a body Rust predicts
    // byte-exactly, once, within 300s, while the header rides the spawn's own
    // environment and so also covers what an agent composes for itself mid-run
    // (sub-agent Task prompts, retries, resumed turns) — the residue that put
    // 4.32 MB of Redline's own instruction text into the searchable lake.
    //
    // Both are evaluated, and `claim_agent_prompt` runs FIRST and unconditionally
    // so the registration is consumed either way; the host's handoffs (draft →
    // session, orchestration → run monitor) hang off this same branch and must
    // run for a header-marked spawn too — the overnight queue's orchestrator is
    // spawned carrying the header, and skipping early would cost it its
    // `running` beacon and its run-watcher anchor.
    let lookup = HttpHeaders(&headers);
    let agent_seat = state.ingest.agent_seat(&lookup);
    let cx = IngestContext {
        payload: &v,
        prompt: &prompt,
        headers: &lookup,
        session_id: claude_session_id.as_deref().filter(|s| !s.is_empty()),
        cwd: cwd.as_deref(),
        agent_seat: agent_seat.as_deref(),
    };

    // A host's control traffic (Redline: the restore trigger), answered with
    // whatever the host wants the hook to say, and never recorded.
    if let Some(body) = state.ingest.intercept(&cx) {
        return (StatusCode::OK, Json(body)).into_response();
    }

    let bh = body_hash(&prompt);
    let claimed = claim_agent_prompt(&bh);
    // Every seat but the host's exemptions means "machine text, skip it".
    let seat_suppresses = agent_seat
        .as_deref()
        .is_some_and(|s| state.ingest.seat_suppresses(s));
    if claimed || seat_suppresses {
        state.ingest.on_agent_prompt_skipped(&cx, &bh);
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "skipped": "agent_dup",
                "by": if claimed { "guard" } else { "header" },
                "seat": agent_seat,
            })),
        )
            .into_response();
    }

    let origin = state.ingest.classify_origin(cwd.as_deref());
    if origin == Origin::External {
        // External-session capture toggle (default on).
        if !state.ingest.capture_external() {
            return (StatusCode::OK, Json(serde_json::json!({ "skipped": "external_off" })))
                .into_response();
        }
    }
    let surface = if origin == Origin::Redline {
        "pty"
    } else {
        "external"
    };
    let req = CaptureRequest {
        body: prompt.clone(),
        origin,
        surface: surface.to_string(),
        session: claude_session_id.clone(),
        project: cwd.clone(),
    };
    let (response, seq) = match state.api.capture(&req) {
        Ok(Some(seq)) => {
            state.events.changed(&[Change::Ledger]);
            ((StatusCode::CREATED, Json(serde_json::json!({ "seq": seq }))).into_response(), Some(seq))
        }
        Ok(None) => ((StatusCode::OK, Json(serde_json::json!({ "skipped": "dup" }))).into_response(), None),
        Err(e) => {
            tracing::warn!(error = %e, "prompt ingest failed");
            ((StatusCode::OK, Json(serde_json::json!({ "skipped": "error" }))).into_response(), None)
        }
    };
    // After the row exists (or didn't): the host's follow-through — Redline
    // stamps this session's still-unstamped prompts from the transcript tail.
    state.ingest.on_recorded(&cx, seq);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use polis_core::host::IngestObserver;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    /// Golden: the exact UserPromptSubmit payload captured from claude 2.1.199
    /// (docs/protocol-verification.md). The submitted text is at `prompt` — NOT
    /// `user_input` as the public docs claim.
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
        let alt = serde_json::json!({ "user_input": "  spaced  " });
        assert_eq!(ingest_prompt_text(&alt), "spaced");
        assert_eq!(ingest_prompt_text(&serde_json::json!({ "prompt": "   " })), "");
        assert_eq!(ingest_prompt_text(&serde_json::json!({})), "");
    }

    async fn post(app: &axum::Router, body: &str, headers: &[(&str, &str)]) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method("POST").uri("/v1/prompts/ingest").header("content-type", "application/json");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let resp = app.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    /// The response bodies the hook's `case` guard and every consumer read —
    /// unchanged by the move: too_large / unparseable / empty / the 201 seq /
    /// dup / the guard's agent_dup.
    #[tokio::test]
    async fn the_hook_json_shapes_are_unchanged() {
        let app = testing::app();
        let big = format!(r#"{{"prompt":"{}"}}"#, "x".repeat(70 * 1024));
        assert_eq!(post(&app, &big, &[]).await, (StatusCode::OK, serde_json::json!({ "skipped": "too_large" })));
        assert_eq!(post(&app, "not json", &[]).await, (StatusCode::OK, serde_json::json!({ "skipped": "unparseable" })));
        assert_eq!(post(&app, r#"{"prompt":"  "}"#, &[]).await, (StatusCode::OK, serde_json::json!({ "skipped": "empty" })));
        let (s, v) = post(&app, r#"{"prompt":"first words","session_id":"s1","cwd":"/tmp/p"}"#, &[]).await;
        assert_eq!((s, v), (StatusCode::CREATED, serde_json::json!({ "seq": 1 })));
        let (s, v) = post(&app, r#"{"prompt":"first words","session_id":"s1","cwd":"/tmp/p"}"#, &[]).await;
        assert_eq!((s, v), (StatusCode::OK, serde_json::json!({ "skipped": "dup" })));

        // The consume-once guard: a body a host registered before spawning is
        // skipped once (`by: guard`, no seat) and captured the second time.
        polis_core::ledger::register_agent_prompt("constructed by the host");
        let (s, v) = post(&app, r#"{"prompt":"constructed by the host","session_id":"s2"}"#, &[]).await;
        assert_eq!((s, v), (StatusCode::OK, serde_json::json!({ "skipped": "agent_dup", "by": "guard", "seat": null })));
        let (s, v) = post(&app, r#"{"prompt":"constructed by the host","session_id":"s2"}"#, &[]).await;
        assert_eq!((s, v["seq"].clone()), (StatusCode::CREATED, serde_json::json!(2)));
    }

    /// A host that labels its spawns: the seat header suppresses (`by:
    /// header`, the seat echoed), the exempt seat does not, an intercept
    /// answers instead of recording, and the origin/setting forks and the
    /// after-record callback all fire with the route's facts.
    struct Host {
        log: Mutex<Vec<String>>,
        capture_external: bool,
    }
    impl IngestObserver for Host {
        fn intercept(&self, cx: &IngestContext<'_>) -> Option<serde_json::Value> {
            cx.prompt.starts_with("RESTORE:").then(|| serde_json::json!({ "skipped": "restore_control", "hookSpecificOutput": {"additionalContext": "protocol"} }))
        }
        fn agent_seat(&self, headers: &dyn IngestHeaders) -> Option<String> {
            headers.get("X-Test-Agent").filter(|s| !s.is_empty()).map(str::to_string)
        }
        fn seat_suppresses(&self, seat: &str) -> bool {
            seat != "restore"
        }
        fn on_agent_prompt_skipped(&self, cx: &IngestContext<'_>, body_hash: &str) {
            self.log.lock().unwrap().push(format!("skipped:{}:{}", cx.session_id.unwrap_or("-"), &body_hash[..6]));
        }
        fn classify_origin(&self, cwd: Option<&str>) -> Origin {
            if cwd == Some("/home") { Origin::Redline } else { Origin::External }
        }
        fn capture_external(&self) -> bool {
            self.capture_external
        }
        fn on_recorded(&self, cx: &IngestContext<'_>, seq: Option<i64>) {
            self.log.lock().unwrap().push(format!("recorded:{}:{:?}", cx.session_id.unwrap_or("-"), seq));
        }
    }

    #[tokio::test]
    async fn the_observer_is_asked_at_every_fork() {
        let host = Arc::new(Host { log: Mutex::new(Vec::new()), capture_external: true });
        let mut state = testing::state();
        state.ingest = host.clone();
        let app = testing::app_with(state);

        let (s, v) = post(&app, r#"{"prompt":"RESTORE: now","session_id":"s1"}"#, &[]).await;
        assert_eq!((s, v["skipped"].as_str()), (StatusCode::OK, Some("restore_control")));
        assert!(v["hookSpecificOutput"].is_object(), "the host's answer is the body");

        let (s, v) = post(&app, r#"{"prompt":"machine text","session_id":"s2"}"#, &[("X-Test-Agent", "classifier")]).await;
        assert_eq!((s, v), (StatusCode::OK, serde_json::json!({ "skipped": "agent_dup", "by": "header", "seat": "classifier" })));

        let (s, v) = post(&app, r#"{"prompt":"typed in a restored terminal","session_id":"s3","cwd":"/home"}"#, &[("X-Test-Agent", "restore")]).await;
        assert_eq!((s, v["seq"].clone()), (StatusCode::CREATED, serde_json::json!(1)), "the exempt seat is captured");

        let (s, v) = post(&app, r#"{"prompt":"elsewhere","session_id":"","cwd":"/elsewhere"}"#, &[]).await;
        assert_eq!((s, v["seq"].clone()), (StatusCode::CREATED, serde_json::json!(2)));

        let log = host.log.lock().unwrap().clone();
        assert_eq!(log, vec![
            "skipped:s2:".to_string() + &polis_core::ledger::body_hash("machine text")[..6],
            "recorded:s3:Some(1)".to_string(),
            "recorded:-:None".to_string().replace("None", "Some(2)"),
        ]);

        // The captured rows carry the origin's surface.
        let api = &app;
        let resp = api.clone().oneshot(Request::builder().uri("/v1/context/prompts?limit=10").body(Body::empty()).unwrap()).await.unwrap();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let items: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let surfaces: Vec<&str> = items["items"].as_array().unwrap().iter().map(|i| i["surface"].as_str().unwrap()).collect();
        assert_eq!(surfaces, vec!["pty", "external"]);
    }

    #[tokio::test]
    async fn external_capture_can_be_switched_off_by_the_host() {
        let host = Arc::new(Host { log: Mutex::new(Vec::new()), capture_external: false });
        let mut state = testing::state();
        state.ingest = host;
        let app = testing::app_with(state);
        let (s, v) = post(&app, r#"{"prompt":"elsewhere","cwd":"/elsewhere"}"#, &[]).await;
        assert_eq!((s, v), (StatusCode::OK, serde_json::json!({ "skipped": "external_off" })));
        let (s, v) = post(&app, r#"{"prompt":"at home","cwd":"/home"}"#, &[]).await;
        assert_eq!((s, v["seq"].clone()), (StatusCode::CREATED, serde_json::json!(1)), "the host's own projects still capture");
    }
}
