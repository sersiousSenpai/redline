// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `lib.rs`'s `mod plan_received_launch_tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

#[test]
fn absent_launch_claim_is_omitted_from_plan_event() {
    let event = super::PlanReceivedEvent { session_id: "plan".into(), launch_id: None, version: 1, is_new_session: true, thread_start: true, resolutions_attached: 0, unmatched_resolution_ids: vec![], unresolved_submitted_ids: vec![], resolution_parse_error: None, mode: "revise", ask_mode_violated: None, restored: false };
    let json = serde_json::to_value(event).unwrap();
    assert!(json.get("launchId").is_none());
}
