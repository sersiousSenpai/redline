//! SDK for Redline WASM extensions (ABI v1).
//!
//! An extension is a plain Rust type implementing [`Extension`], exported
//! with [`export!`], and built for `wasm32-unknown-unknown`:
//!
//! ```ignore
//! use redline_extension_sdk as sdk;
//! use sdk::{Extension, Host, Event};
//!
//! #[derive(Default)]
//! struct Greeter;
//!
//! impl Extension for Greeter {
//!     fn on_event(&mut self, host: &dyn Host, event: &Event) -> Result<(), String> {
//!         if let Event::PlanReceived(plan) = event {
//!             // requires scope `plan.comment` in extension.json
//!             sdk::plan::comment(host, &plan.session_id, "👋 a plan arrived", None);
//!         }
//!         Ok(())
//!     }
//! }
//!
//! sdk::export!(Greeter);
//! ```
//!
//! Unit tests run as plain Rust with [`testing::MockHost`] — no wasm
//! toolchain. Honest boundary: mocks exercise the author's logic, not real
//! authorization or fuel; those live in Redline's own host tests.

pub use redline_extension_abi as abi;
pub use redline_extension_abi::events::Event;
pub use redline_extension_abi::host::{HostCallRequest, HostCallResponse};
pub use redline_extension_abi::API_VERSION;

/// Log severity for [`Host::log`], matching the IDL's numeric levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

/// The host surface an extension talks to. In a wasm build this is the real
/// bridge over the `redline` imports; in unit tests it is
/// [`testing::MockHost`].
pub trait Host {
    /// One authorized call into Redline's `/v1` control plane. The host
    /// attaches the extension's per-boot token — scope denials come back as
    /// status 401, exactly as over HTTP.
    fn call(&self, req: &HostCallRequest) -> HostCallResponse;
    /// Log a line into Redline's tracing output.
    fn log(&self, level: Level, message: &str);
}

/// What an extension author implements. `Default` constructs the single
/// long-lived instance at load.
pub trait Extension: Default {
    /// Called once after instantiation, before any event. Returning `Err`
    /// counts as a strike on the host side.
    fn init(&mut self, _host: &dyn Host) -> Result<(), String> {
        Ok(())
    }
    /// One event delivery (sequential per extension). Returning `Err` counts
    /// as a strike.
    fn on_event(&mut self, host: &dyn Host, event: &Event) -> Result<(), String>;
}

/// Build a request with a JSON body.
fn json_req(method: &str, path: &str, body: serde_json::Value) -> HostCallRequest {
    HostCallRequest {
        method: method.to_string(),
        path: path.to_string(),
        body: Some(body.to_string()),
    }
}

/// Plan-session helpers.
pub mod plan {
    use super::*;

    /// Write a tracked `[feedback]` comment that rides the next revision.
    /// Requires scope `plan.comment`.
    pub fn comment(
        host: &dyn Host,
        session_id: &str,
        body: &str,
        block_id: Option<&str>,
    ) -> HostCallResponse {
        host.call(&json_req(
            "POST",
            &format!("/v1/sessions/{session_id}/comments"),
            serde_json::json!({ "body": body, "block_id": block_id }),
        ))
    }

    /// Post a tracked edit suggestion against a plan block. `body` is the
    /// route's JSON (`{block_id, op, markdown, …}`). Requires scope
    /// `plan.suggest`.
    pub fn suggest(
        host: &dyn Host,
        session_id: &str,
        body: serde_json::Value,
    ) -> HostCallResponse {
        host.call(&json_req(
            "POST",
            &format!("/v1/sessions/{session_id}/suggestions"),
            body,
        ))
    }

    /// Read the latest plan revision's block structure. Open route — no
    /// scope needed.
    pub fn latest(host: &dyn Host, session_id: &str) -> HostCallResponse {
        host.call(&HostCallRequest {
            method: "GET".to_string(),
            path: format!("/v1/sessions/{session_id}/plan"),
            body: None,
        })
    }
}

/// Code-review helpers.
pub mod review {
    use super::*;

    /// Post a finding into a live review. `body` is the route's JSON
    /// (schema-only, required source tag). Requires scope `review.annotate`.
    pub fn annotate(host: &dyn Host, body: serde_json::Value) -> HostCallResponse {
        host.call(&json_req("POST", "/v1/reviews/annotations", body))
    }
}

/// Embedded-browser helpers.
pub mod browser {
    use super::*;

    /// All open tabs with ordinals. Open route — no scope needed.
    pub fn tabs(host: &dyn Host) -> HostCallResponse {
        host.call(&HostCallRequest {
            method: "GET".to_string(),
            path: "/v1/browser/tabs".to_string(),
            body: None,
        })
    }

    /// Navigate a tab. Requires scope `browser.drive`.
    pub fn navigate(host: &dyn Host, tab: Option<&str>, url: &str) -> HostCallResponse {
        host.call(&json_req(
            "POST",
            "/v1/browser/navigate",
            serde_json::json!({ "tab": tab, "url": url }),
        ))
    }
}

/// The sanctioned UI slot.
pub mod panel {
    use super::*;

    /// Replace this extension's markdown panel in Redline's Extensions view.
    /// `name` must match the manifest's `name` (the route rejects a mismatch
    /// with the bearer's grant). Requires scope `ui.panel`.
    pub fn set(host: &dyn Host, name: &str, markdown: &str) -> HostCallResponse {
        host.call(&json_req(
            "POST",
            &format!("/v1/extensions/{name}/panel"),
            serde_json::json!({ "markdown": markdown }),
        ))
    }
}

/// Plain-Rust test double. Records every call and log line; responds from a
/// canned `(method, path) → response` table, 404ing anything unmatched.
pub mod testing {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MockHost {
        canned: Vec<(String, String, HostCallResponse)>,
        calls: Mutex<Vec<HostCallRequest>>,
        logs: Mutex<Vec<(Level, String)>>,
    }

    impl MockHost {
        pub fn new() -> Self {
            Self::default()
        }

        /// Builder: respond to `method path` with `status`/`body`.
        pub fn respond(mut self, method: &str, path: &str, status: u16, body: &str) -> Self {
            self.canned.push((
                method.to_string(),
                path.to_string(),
                HostCallResponse {
                    status,
                    body: body.to_string(),
                },
            ));
            self
        }

        /// Every request the extension made, in order.
        pub fn calls(&self) -> Vec<HostCallRequest> {
            self.calls.lock().unwrap().clone()
        }

        /// Every log line the extension emitted, in order.
        pub fn logs(&self) -> Vec<(Level, String)> {
            self.logs.lock().unwrap().clone()
        }
    }

    impl Host for MockHost {
        fn call(&self, req: &HostCallRequest) -> HostCallResponse {
            self.calls.lock().unwrap().push(req.clone());
            self.canned
                .iter()
                .find(|(m, p, _)| m == &req.method && p == &req.path)
                .map(|(_, _, resp)| resp.clone())
                .unwrap_or(HostCallResponse {
                    status: 404,
                    body: "{\"error\":\"no canned response (MockHost)\"}".to_string(),
                })
        }

        fn log(&self, level: Level, message: &str) {
            self.logs.lock().unwrap().push((level, message.to_string()));
        }
    }
}

/// Wasm-side plumbing the [`export!`] macro wires up. Only meaningful on
/// `wasm32-unknown-unknown`; on native targets the macro expands to nothing
/// so the same crate unit-tests with [`testing::MockHost`].
#[cfg(target_arch = "wasm32")]
pub mod wasm {
    use super::*;

    #[link(wasm_import_module = "redline")]
    extern "C" {
        fn host_call(req_ptr: i32, req_len: i32) -> i64;
        fn host_log(level: i32, msg_ptr: i32, msg_len: i32);
    }

    /// The real [`Host`] over the `redline` imports.
    pub struct HostBridge;

    impl Host for HostBridge {
        fn call(&self, req: &HostCallRequest) -> HostCallResponse {
            let json = match serde_json::to_string(req) {
                Ok(j) => j,
                Err(e) => {
                    return HostCallResponse {
                        status: 400,
                        body: format!("{{\"error\":\"request encode: {e}\"}}"),
                    }
                }
            };
            let packed = unsafe { host_call(json.as_ptr() as i32, json.len() as i32) };
            if packed == 0 {
                return HostCallResponse {
                    status: 500,
                    body: "{\"error\":\"host_call failed\"}".to_string(),
                };
            }
            let (ptr, len) = abi::abi::unpack_ptr_len(packed);
            // The host wrote the response into a buffer it obtained from our
            // `rl_alloc`; taking ownership here frees it when we're done.
            let bytes =
                unsafe { Vec::from_raw_parts(ptr as *mut u8, len as usize, len as usize) };
            serde_json::from_slice(&bytes).unwrap_or(HostCallResponse {
                status: 500,
                body: "{\"error\":\"host_call response decode failed\"}".to_string(),
            })
        }

        fn log(&self, level: Level, message: &str) {
            unsafe {
                host_log(level as i32, message.as_ptr() as i32, message.len() as i32)
            }
        }
    }

    /// Reconstruct (and thereby own) a host-allocated buffer.
    ///
    /// # Safety
    /// `ptr`/`len` must describe a live buffer from `rl_alloc`.
    pub unsafe fn take_buffer(ptr: i32, len: i32) -> Vec<u8> {
        Vec::from_raw_parts(ptr as *mut u8, len as usize, len as usize)
    }
}

/// Export a type implementing [`Extension`] as an ABI v1 wasm module: wires
/// `rl_api_version`, `rl_alloc`, `rl_free`, `rl_init`, and `rl_on_event` to
/// one long-lived instance. Expands to nothing on non-wasm targets, so the
/// exporting crate still unit-tests natively.
#[macro_export]
macro_rules! export {
    ($ty:ty) => {
        #[cfg(target_arch = "wasm32")]
        mod __redline_extension_export {
            use super::*;

            static INSTANCE: std::sync::Mutex<Option<$ty>> = std::sync::Mutex::new(None);

            #[no_mangle]
            pub extern "C" fn rl_api_version() -> i32 {
                $crate::API_VERSION as i32
            }

            #[no_mangle]
            pub extern "C" fn rl_alloc(len: i32) -> i32 {
                if len <= 0 {
                    return 0;
                }
                let mut buf = Vec::<u8>::with_capacity(len as usize);
                let ptr = buf.as_mut_ptr();
                std::mem::forget(buf);
                ptr as i32
            }

            #[no_mangle]
            pub extern "C" fn rl_free(ptr: i32, len: i32) {
                if ptr == 0 || len <= 0 {
                    return;
                }
                unsafe {
                    drop(Vec::from_raw_parts(ptr as *mut u8, 0, len as usize));
                }
            }

            #[no_mangle]
            pub extern "C" fn rl_init() -> i32 {
                let mut slot = INSTANCE.lock().unwrap();
                let mut ext = <$ty as Default>::default();
                match $crate::Extension::init(&mut ext, &$crate::wasm::HostBridge) {
                    Ok(()) => {
                        *slot = Some(ext);
                        0
                    }
                    Err(_) => 1,
                }
            }

            #[no_mangle]
            pub extern "C" fn rl_on_event(
                name_ptr: i32,
                name_len: i32,
                payload_ptr: i32,
                payload_len: i32,
            ) -> i32 {
                // Take ownership of both host-allocated buffers so they free
                // on every path out of this call.
                let name_buf = unsafe { $crate::wasm::take_buffer(name_ptr, name_len) };
                let payload_buf =
                    unsafe { $crate::wasm::take_buffer(payload_ptr, payload_len) };
                let (Ok(name), Ok(payload)) = (
                    std::str::from_utf8(&name_buf),
                    std::str::from_utf8(&payload_buf),
                ) else {
                    return 1;
                };
                let event = $crate::Event::decode(name, payload);
                let mut slot = INSTANCE.lock().unwrap();
                let Some(ext) = slot.as_mut() else { return 1 };
                match $crate::Extension::on_event(ext, &$crate::wasm::HostBridge, &event) {
                    Ok(()) => 0,
                    Err(_) => 1,
                }
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use redline_extension_abi::events;

    /// The doc example, driven natively through MockHost.
    #[derive(Default)]
    struct Greeter {
        seen: usize,
    }

    impl Extension for Greeter {
        fn on_event(&mut self, host: &dyn Host, event: &Event) -> Result<(), String> {
            if let Event::PlanReceived(plan) = event {
                self.seen += 1;
                let resp = plan::comment(host, &plan.session_id, "a plan arrived", None);
                if resp.status >= 400 {
                    host.log(Level::Warn, &format!("comment failed: {}", resp.status));
                }
            }
            Ok(())
        }
    }

    export!(Greeter); // expands to nothing natively; pins the macro compiles

    fn plan_event() -> Event {
        Event::decode(
            events::PLAN_RECEIVED,
            &serde_json::to_string(&events::PlanReceived {
                session_id: "sess-1".into(),
                version: 2,
                is_new_session: false,
                thread_start: false,
                mode: "revise".into(),
                restored: false,
                ts_ms: 1,
            })
            .unwrap(),
        )
    }

    #[test]
    fn extension_logic_runs_against_mock_host() {
        let host = testing::MockHost::new().respond(
            "POST",
            "/v1/sessions/sess-1/comments",
            201,
            "{\"id\":\"c1\"}",
        );
        let mut ext = Greeter::default();
        ext.on_event(&host, &plan_event()).unwrap();
        assert_eq!(ext.seen, 1);
        let calls = host.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].method, "POST");
        assert_eq!(calls[0].path, "/v1/sessions/sess-1/comments");
        let body: serde_json::Value =
            serde_json::from_str(calls[0].body.as_deref().unwrap()).unwrap();
        assert_eq!(body["body"], "a plan arrived");
        assert!(host.logs().is_empty());
    }

    #[test]
    fn unmatched_call_is_a_404_and_gets_logged() {
        let host = testing::MockHost::new();
        let mut ext = Greeter::default();
        ext.on_event(&host, &plan_event()).unwrap();
        assert_eq!(host.logs().len(), 1);
        assert_eq!(host.logs()[0].0, Level::Warn);
    }

    #[test]
    fn helpers_hit_documented_routes() {
        let host = testing::MockHost::new();
        plan::suggest(&host, "s", serde_json::json!({"op": "replace"}));
        plan::latest(&host, "s");
        review::annotate(&host, serde_json::json!({}));
        browser::tabs(&host);
        browser::navigate(&host, None, "https://example.com");
        panel::set(&host, "my-ext", "# hi");
        let paths: Vec<String> = host
            .calls()
            .iter()
            .map(|c| format!("{} {}", c.method, c.path))
            .collect();
        assert_eq!(
            paths,
            vec![
                "POST /v1/sessions/s/suggestions",
                "GET /v1/sessions/s/plan",
                "POST /v1/reviews/annotations",
                "GET /v1/browser/tabs",
                "POST /v1/browser/navigate",
                "POST /v1/extensions/my-ext/panel",
            ]
        );
    }
}
