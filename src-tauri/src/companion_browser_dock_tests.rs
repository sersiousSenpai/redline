// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `companion.rs`'s `mod browser_dock_tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;
#[test]
fn browser_authority_requires_browser_surface_and_stable_target() {
    let mut surface = SurfaceInfo {
        kind: "plan".into(),
        ..SurfaceInfo::default()
    };
    assert!(capture_browser_target(&surface, Some("browser-page-one".into()), None).is_none());
    surface.kind = "browser".into();
    assert!(capture_browser_target(&surface, None, None).is_none());
    let target = capture_browser_target(
        &surface,
        Some("browser-page-one".into()),
        Some("mission-one".into()),
    )
    .unwrap();
    let prompt = browser_turn_context(Some(&target));
    assert!(prompt.contains("POST /v1/browser/action"));
    assert!(prompt.contains("mission-one"));
    assert!(browser_turn_context(None).contains("read-only"));
    assert!(!browser_turn_context(None).contains("POST /v1/browser/action"));
}
#[test]
fn queued_browser_target_does_not_follow_later_tab_or_surface_switch() {
    let turns: Arc<Turns<QueuedCompanionSend>> = Arc::new(Turns::new());
    let active = turns.begin("chat").unwrap();
    let token = active.token();
    let surface = SurfaceInfo {
        kind: "browser".into(),
        detail: Some("https://first.test".into()),
        ..SurfaceInfo::default()
    };
    let payload = QueuedCompanionSend {
        mode: TurnMode::Chat,
        message_id: "queued".into(),
        text: "Fill the field".into(),
        cwd: None,
        surface: surface.clone(),
        harness: ConversationHarness::default(),
        browser_target: capture_browser_target(
            &surface,
            Some("browser-first".into()),
            Some("mission-first".into()),
        ),
        context: None,
        context_all: None,
    };
    assert!(matches!(
        turns.begin_or_enqueue(
            "chat",
            QueuedTurn {
                message_id: "queued".into(),
                text: "Fill the field".into(),
                queued_at: 1
            },
            payload
        ),
        SendSlot::Enqueued
    ));
    let later_surface = SurfaceInfo {
        kind: "browser".into(),
        detail: Some("https://second.test".into()),
        ..SurfaceInfo::default()
    };
    let later = capture_browser_target(
        &later_surface,
        Some("browser-second".into()),
        Some("mission-second".into()),
    )
    .unwrap();
    drop(active);
    let (_, next) = turns.finish_and_pop("chat", token);
    let (_, queued, _) = next.unwrap();
    let captured = queued.browser_target.unwrap();
    assert_eq!(captured.label, "browser-first");
    assert_ne!(captured.label, later.label);
    assert_eq!(captured.mission_id.as_deref(), Some("mission-first"));
    assert_eq!(
        captured.surface.detail.as_deref(),
        Some("https://first.test")
    );
}
