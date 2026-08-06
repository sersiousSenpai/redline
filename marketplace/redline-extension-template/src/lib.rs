// SPDX-License-Identifier: Apache-2.0
//! The template Redline extension: greets every plan that arrives for
//! review with a `[feedback]` comment. Everything an extension can be is
//! visible from here — events in, authorized `host_call`s out, nothing
//! else. See extension.json for the scopes/events this code assumes.

use redline_extension_sdk as sdk;
use sdk::{Event, Extension, Host};

#[derive(Default)]
struct Greeter {
    greeted: u32,
}

impl Extension for Greeter {
    fn on_event(&mut self, host: &dyn Host, event: &Event) -> Result<(), String> {
        if let Event::PlanReceived(plan) = event {
            self.greeted += 1;
            // Requires scope `plan.comment` (declared in extension.json).
            // A 401 here means the manifest and the code disagree — treat
            // it as a bug, not something to retry.
            let resp = sdk::plan::comment(
                host,
                &plan.session_id,
                &format!(
                    "👋 plan v{} received — greeting #{} from the template extension",
                    plan.version, self.greeted
                ),
                None,
            );
            if resp.status >= 400 {
                return Err(format!("plan.comment failed: {} {}", resp.status, resp.body));
            }
        }
        Ok(())
    }
}

sdk::export!(Greeter);

// Unit tests run as plain Rust against MockHost — no wasm toolchain needed.
// (Real authorization, fuel, and isolation are exercised by Redline's own
// host tests; these test YOUR logic.)
#[cfg(test)]
mod tests {
    use super::*;
    use sdk::abi::events;
    use sdk::testing::MockHost;

    #[test]
    fn greets_a_received_plan() {
        let host = MockHost::new().respond(
            "POST",
            "/v1/sessions/s-1/comments",
            201,
            r#"{"id":"c1"}"#,
        );
        let mut ext = Greeter::default();
        let event = Event::decode(
            events::PLAN_RECEIVED,
            &serde_json::to_string(&events::PlanReceived {
                session_id: "s-1".into(),
                version: 3,
                is_new_session: false,
                thread_start: false,
                mode: "revise".into(),
                restored: false,
                ts_ms: 0,
            })
            .unwrap(),
        );
        ext.on_event(&host, &event).unwrap();

        let calls = host.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].path, "/v1/sessions/s-1/comments");
        assert!(calls[0].body.as_deref().unwrap().contains("plan v3 received"));
    }

    #[test]
    fn ignores_events_it_did_not_subscribe_to() {
        let host = MockHost::new();
        let mut ext = Greeter::default();
        let event = Event::decode(events::LEDGER_CHANGED, r#"{"ts_ms":0}"#);
        ext.on_event(&host, &event).unwrap();
        assert!(host.calls().is_empty());
    }
}
