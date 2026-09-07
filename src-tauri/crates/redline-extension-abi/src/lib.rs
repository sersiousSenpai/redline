//! ABI v1 for Redline WASM extensions — the single source of truth shared by
//! the Redline host (`extension_host.rs`) and the publishable extension SDK
//! (`redline-extension-sdk`). Host and guest both compile against the types
//! and name constants here, so the two sides cannot drift by construction.
//!
//! The canonical IDL is `wit/redline-host.wit` (embedded as [`WIT`]). ABI v1
//! is core-wasm + JSON: guests are `wasm32-unknown-unknown` modules, every
//! record crosses the boundary as UTF-8 JSON in guest linear memory, and
//! there is **no WASI** — no filesystem, network, environment, or clock.
//! Timestamps ride inside event payloads as `ts_ms`.

use serde::{Deserialize, Serialize};

/// ABI major version. The guest's `rl_api_version` export must return this;
/// a mismatch skips the module with a warning (never a boot failure).
pub const API_VERSION: u32 = 1;

/// The canonical IDL, embedded so the host and SDK can surface it in docs
/// and diagnostics without a repo checkout.
pub const WIT: &str = include_str!("../wit/redline-host.wit");

/// Core-wasm surface names — the one place they are spelled.
pub mod abi {
    /// Import module name the guest links host functions from.
    pub const HOST_MODULE: &str = "redline";
    /// `host_call(req_ptr: i32, req_len: i32) -> i64` — packed response ptr/len.
    pub const HOST_CALL: &str = "host_call";
    /// `host_log(level: i32, msg_ptr: i32, msg_len: i32)`.
    pub const HOST_LOG: &str = "host_log";

    pub const EXPORT_API_VERSION: &str = "rl_api_version";
    pub const EXPORT_ALLOC: &str = "rl_alloc";
    pub const EXPORT_FREE: &str = "rl_free";
    pub const EXPORT_INIT: &str = "rl_init";
    pub const EXPORT_ON_EVENT: &str = "rl_on_event";

    /// Every export a valid ABI v1 module must expose (plus `memory`).
    pub const GUEST_EXPORTS: &[&str] = &[
        EXPORT_API_VERSION,
        EXPORT_ALLOC,
        EXPORT_FREE,
        EXPORT_INIT,
        EXPORT_ON_EVENT,
    ];

    /// Pack a guest pointer + length into the `i64` `host_call` returns.
    /// `0` is reserved for "host failure" (a null pointer is never valid).
    pub fn pack_ptr_len(ptr: u32, len: u32) -> i64 {
        ((ptr as i64) << 32) | (len as i64)
    }

    /// Inverse of [`pack_ptr_len`].
    pub fn unpack_ptr_len(packed: i64) -> (u32, u32) {
        (((packed >> 32) & 0xffff_ffff) as u32, (packed & 0xffff_ffff) as u32)
    }
}

/// Scope name constants — the vocabulary of `ROUTE_TABLE` grants. The app's
/// `auth.rs` re-exports these (it stays sovereign over route classes and the
/// `authorize()` decision; only the names live here so manifests, SDK helper
/// docs, and the auth table spell them identically).
pub mod scopes {
    pub const PLAN_SUGGEST: &str = "plan.suggest";
    pub const PLAN_COMMENT: &str = "plan.comment";
    pub const PLAN_OFFER: &str = "plan.offer";
    pub const BROWSER_DRIVE: &str = "browser.drive";
    pub const CONSULT: &str = "consult";
    pub const MEMORY_PROPOSE: &str = "memory.propose";
    /// Append to the memory record: remember, annotate, import events,
    /// browse events (`polis_server::scopes::MEMORY_WRITE`, pinned equal).
    pub const MEMORY_WRITE: &str = "memory.write";
    /// Forget a memory body — destructive, so its own grant: a token that
    /// may write must not thereby be able to erase.
    pub const MEMORY_FORGET: &str = "memory.forget";
    /// Run the memory organizer or the semantic indexer now (spends the
    /// model / CPU on demand).
    pub const MEMORY_ORGANIZE: &str = "memory.organize";
    pub const DRAFTER_SUGGEST: &str = "drafter.suggest";
    pub const REVIEW_ANNOTATE: &str = "review.annotate";
    /// File an orchestrated run's structured exit report (`plan_runs`).
    pub const ORCH_REPORT: &str = "orchestration.report";
    /// Write the extension's sanctioned UI slot: a host-sanitized markdown
    /// panel in Redline's Extensions view. The only UI surface v1 grants.
    pub const UI_PANEL: &str = "ui.panel";
    /// File new items into the work graph (`POST /v1/work`).
    pub const WORK_FILE: &str = "work.file";
    /// Claim and close work-graph items (`/v1/work/:id/claim`, `…/close`).
    pub const WORK_CLAIM: &str = "work.claim";

    pub const KNOWN_SCOPES: &[&str] = &[
        PLAN_SUGGEST,
        PLAN_COMMENT,
        PLAN_OFFER,
        BROWSER_DRIVE,
        CONSULT,
        MEMORY_PROPOSE,
        MEMORY_WRITE,
        MEMORY_FORGET,
        MEMORY_ORGANIZE,
        DRAFTER_SUGGEST,
        REVIEW_ANNOTATE,
        ORCH_REPORT,
        UI_PANEL,
        WORK_FILE,
        WORK_CLAIM,
    ];

    /// Plain-language description per scope — consumed by the generated
    /// extension docs today and the marketplace consent dialog later. A test
    /// asserts no known scope goes undescribed.
    pub fn describe(scope: &str) -> Option<&'static str> {
        Some(match scope {
            PLAN_SUGGEST => "post tracked edit suggestions against plan blocks",
            PLAN_COMMENT => "write [feedback] comments that ride the next plan revision",
            PLAN_OFFER => "stage offered plan items the user taps to accept",
            BROWSER_DRIVE => "drive the embedded browser (navigate, click, query, download)",
            CONSULT => "consult other surfaces' agents for digests",
            MEMORY_PROPOSE => "stage reviewable ClassMemory proposals",
            MEMORY_WRITE => "append to the memory record (remember, annotate, import events, browse events)",
            MEMORY_FORGET => "forget a memory body (destructive; granted separately from writing)",
            MEMORY_ORGANIZE => "run the memory organizer or semantic indexer on demand",
            DRAFTER_SUGGEST => "write tracked suggestions into a live draft",
            REVIEW_ANNOTATE => "post and clear findings in a live code review",
            ORCH_REPORT => "file an orchestrated run's structured exit report",
            UI_PANEL => "render a sanitized markdown panel in the Extensions view",
            WORK_FILE => "file new items into the work graph",
            WORK_CLAIM => "claim and close work-graph items",
            _ => return None,
        })
    }
}

/// Events v1 — the closed vocabulary a `kind: "wasm"` manifest may subscribe
/// to, and the typed payload each delivery carries (as JSON).
pub mod events {
    use super::*;

    pub const PLAN_RECEIVED: &str = "plan.received";
    pub const REVIEW_STARTED: &str = "review.started";
    pub const REVIEW_ANNOTATIONS_CHANGED: &str = "review.annotations_changed";
    pub const COMMENT_OFFER: &str = "comment.offer";
    pub const LEDGER_CHANGED: &str = "ledger.changed";
    pub const SUGGESTION_RESOLVED: &str = "suggestion.resolved";

    pub const KNOWN_EVENTS: &[&str] = &[
        PLAN_RECEIVED,
        REVIEW_STARTED,
        REVIEW_ANNOTATIONS_CHANGED,
        COMMENT_OFFER,
        LEDGER_CHANGED,
        SUGGESTION_RESOLVED,
    ];

    /// A plan arrived for review (the ExitPlanMode hold opened).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct PlanReceived {
        pub session_id: String,
        pub version: i64,
        pub is_new_session: bool,
        pub thread_start: bool,
        /// "revise" or "ask" (discuss round-trip).
        pub mode: String,
        pub restored: bool,
        pub ts_ms: i64,
    }

    /// A code review opened (or advanced a round) and is holding.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ReviewStarted {
        pub review_id: String,
        pub repo_path: String,
        pub source: String,
        pub round: i64,
        pub ts_ms: i64,
    }

    /// A live review's external annotations changed (added, cleared, or
    /// re-anchored across a round).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ReviewAnnotationsChanged {
        pub review_id: String,
        pub ts_ms: i64,
    }

    /// An agent staged an offered plan item (nothing written yet).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct CommentOffer {
        pub offer_id: String,
        pub session_id: String,
        pub block_id: Option<String>,
        pub body: String,
        pub agent_id: String,
        pub ts_ms: i64,
    }

    /// The append-only prompt/decision ledger grew.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct LedgerChanged {
        pub ts_ms: i64,
    }

    /// The user resolved a drafter tracked suggestion.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct SuggestionResolved {
        pub suggestion_id: String,
        /// "applied" or "rejected".
        pub status: String,
        pub ts_ms: i64,
    }

    /// Typed view of one delivery, for SDK consumers. Unknown names decode to
    /// [`Event::Unknown`] so an older extension degrades under a newer host.
    #[derive(Debug, Clone)]
    #[non_exhaustive]
    pub enum Event {
        PlanReceived(PlanReceived),
        ReviewStarted(ReviewStarted),
        ReviewAnnotationsChanged(ReviewAnnotationsChanged),
        CommentOffer(CommentOffer),
        LedgerChanged(LedgerChanged),
        SuggestionResolved(SuggestionResolved),
        Unknown { name: String, payload: String },
    }

    impl Event {
        /// Decode a delivery. A payload that fails its typed parse also lands
        /// in [`Event::Unknown`] — delivery is never an SDK panic.
        pub fn decode(name: &str, payload: &str) -> Event {
            fn parse<T: serde::de::DeserializeOwned>(payload: &str) -> Option<T> {
                serde_json::from_str(payload).ok()
            }
            match name {
                PLAN_RECEIVED => parse(payload).map(Event::PlanReceived),
                REVIEW_STARTED => parse(payload).map(Event::ReviewStarted),
                REVIEW_ANNOTATIONS_CHANGED => {
                    parse(payload).map(Event::ReviewAnnotationsChanged)
                }
                COMMENT_OFFER => parse(payload).map(Event::CommentOffer),
                LEDGER_CHANGED => parse(payload).map(Event::LedgerChanged),
                SUGGESTION_RESOLVED => parse(payload).map(Event::SuggestionResolved),
                _ => None,
            }
            .unwrap_or_else(|| Event::Unknown {
                name: name.to_string(),
                payload: payload.to_string(),
            })
        }
    }
}

/// `host_call` request/response — the JSON records of the WIT `host`
/// interface, spelled once.
pub mod host {
    use super::*;

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct HostCallRequest {
        /// "GET", "POST", or "DELETE".
        pub method: String,
        /// Concrete route path, e.g. "/v1/browser/tabs".
        pub path: String,
        /// Request body as serialized JSON, if the route takes one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub body: Option<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct HostCallResponse {
        pub status: u16,
        pub body: String,
    }
}

/// Documentation tables — what `docs/extensions-api.md` renders from. Kept as
/// data (not prose in the app repo) so the doc, the payload types, and the
/// event list stay one artifact; tests below pin the tables to the types.
pub mod docs {
    /// (field, type, meaning) rows for one event's payload.
    pub struct EventDoc {
        pub name: &'static str,
        pub purpose: &'static str,
        pub fields: &'static [(&'static str, &'static str, &'static str)],
    }

    pub const EVENT_DOCS: &[EventDoc] = &[
        EventDoc {
            name: super::events::PLAN_RECEIVED,
            purpose: "A plan arrived for review (the ExitPlanMode hold opened)",
            fields: &[
                ("session_id", "string", "plan session id"),
                ("version", "integer", "revision number of the arriving plan"),
                ("is_new_session", "boolean", "first revision of a new session"),
                ("thread_start", "boolean", "fresh plan (vs a feedback revision)"),
                ("mode", "string", "\"revise\" or \"ask\" (discuss round-trip)"),
                ("restored", "boolean", "re-presented by the daemon's Restore path"),
                ("ts_ms", "integer", "unix millis at emit"),
            ],
        },
        EventDoc {
            name: super::events::REVIEW_STARTED,
            purpose: "A code review opened (or advanced a round) and is holding",
            fields: &[
                ("review_id", "string", "review session id"),
                ("repo_path", "string", "absolute repo path under review"),
                ("source", "string", "which flow opened the review"),
                ("round", "integer", "review round, 1-based"),
                ("ts_ms", "integer", "unix millis at emit"),
            ],
        },
        EventDoc {
            name: super::events::REVIEW_ANNOTATIONS_CHANGED,
            purpose: "A live review's external annotations changed",
            fields: &[
                ("review_id", "string", "review session id"),
                ("ts_ms", "integer", "unix millis at emit"),
            ],
        },
        EventDoc {
            name: super::events::COMMENT_OFFER,
            purpose: "An agent staged an offered plan item (nothing written yet)",
            fields: &[
                ("offer_id", "string", "offer id"),
                ("session_id", "string", "plan session id"),
                ("block_id", "string | null", "anchored plan block, if any"),
                ("body", "string", "the offered item's text"),
                ("agent_id", "string", "which agent staged it"),
                ("ts_ms", "integer", "unix millis at emit"),
            ],
        },
        EventDoc {
            name: super::events::LEDGER_CHANGED,
            purpose: "The append-only prompt/decision ledger grew",
            fields: &[("ts_ms", "integer", "unix millis at emit")],
        },
        EventDoc {
            name: super::events::SUGGESTION_RESOLVED,
            purpose: "The user resolved a drafter tracked suggestion",
            fields: &[
                ("suggestion_id", "string", "suggestion id"),
                ("status", "string", "\"applied\" or \"rejected\""),
                ("ts_ms", "integer", "unix millis at emit"),
            ],
        },
    ];
}

/// Render `docs/extensions-api.md` — the extension author's contract page.
/// A golden test in the app repo keeps the committed file current.
pub fn render_extensions_doc() -> String {
    let mut out = String::new();
    out.push_str("# Redline WASM extensions — ABI v1\n\n");
    out.push_str("Generated from `redline-extension-abi` (the crate the host and the SDK both compile against) via `UPDATE_GOLDEN=1 cargo test extensions_doc`. Do not edit by hand.\n\n");
    out.push_str("A `kind: \"wasm\"` extension is a plain core-wasm module (`wasm32-unknown-unknown`) loaded in-process at every Redline launch. It subscribes to events, and calls back into Redline's local control plane through `host_call` — the same authorized `/v1` surface external extensions reach over HTTP, with the same fail-closed scope checks. There is no WASI: no filesystem, network, environment, or clock.\n\n");
    out.push_str("## Manifest (`extension.json`, v2 fields)\n\n");
    out.push_str("```json\n{\n  \"name\": \"my-extension\",\n  \"kind\": \"wasm\",\n  \"module\": \"extension.wasm\",\n  \"api_version\": 1,\n  \"scopes\": [\"plan.comment\"],\n  \"events\": [\"plan.received\"]\n}\n```\n\n");
    out.push_str("`kind` defaults to `\"external\"` (a local process using the `.token` file); `module` is a bare filename next to the manifest; `api_version` must equal the ABI major version below; `events` must be a subset of the closed vocabulary below.\n\n");
    out.push_str(&format!("## ABI\n\n- ABI version: **{API_VERSION}**\n"));
    out.push_str(&format!(
        "- Guest exports: {} (plus `memory`)\n",
        abi::GUEST_EXPORTS
            .iter()
            .map(|e| format!("`{e}`"))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    out.push_str(&format!(
        "- Host imports (module `{}`): `{}`, `{}`\n\n",
        abi::HOST_MODULE,
        abi::HOST_CALL,
        abi::HOST_LOG
    ));
    out.push_str("The canonical IDL is `wit/redline-host.wit`, embedded in the ABI crate as `redline_extension_abi::WIT`. All records cross the boundary as UTF-8 JSON in guest linear memory.\n\n");
    out.push_str("## Events\n\n");
    for doc in docs::EVENT_DOCS {
        out.push_str(&format!("### `{}`\n\n{}.\n\n", doc.name, doc.purpose));
        out.push_str("| Field | Type | Meaning |\n|---|---|---|\n");
        for (field, ty, meaning) in doc.fields {
            out.push_str(&format!("| `{field}` | {ty} | {meaning} |\n"));
        }
        out.push('\n');
    }
    out.push_str("Delivery is sequential per extension from a bounded queue (overflow drops the oldest event and records friction). Each delivery runs under a fuel budget; traps, fuel exhaustion, and non-zero returns count as strikes — three strikes disable the extension until relaunch.\n\n");
    out.push_str("## Scopes\n\n");
    for scope in scopes::KNOWN_SCOPES {
        out.push_str(&format!(
            "- `{}` — {}\n",
            scope,
            scopes::describe(scope).unwrap_or("(undescribed)")
        ));
    }
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The doc tables and the closed event vocabulary are one artifact.
    #[test]
    fn event_docs_cover_known_events_exactly() {
        let documented: Vec<&str> = docs::EVENT_DOCS.iter().map(|d| d.name).collect();
        assert_eq!(documented, events::KNOWN_EVENTS);
    }

    /// Every payload struct serializes to exactly its documented fields —
    /// the doc cannot drift from the types.
    #[test]
    fn event_payload_fields_match_docs() {
        let samples: Vec<(&str, serde_json::Value)> = vec![
            (
                events::PLAN_RECEIVED,
                serde_json::to_value(events::PlanReceived {
                    session_id: "s".into(),
                    version: 1,
                    is_new_session: true,
                    thread_start: true,
                    mode: "revise".into(),
                    restored: false,
                    ts_ms: 0,
                })
                .unwrap(),
            ),
            (
                events::REVIEW_STARTED,
                serde_json::to_value(events::ReviewStarted {
                    review_id: "r".into(),
                    repo_path: "/p".into(),
                    source: "skill".into(),
                    round: 1,
                    ts_ms: 0,
                })
                .unwrap(),
            ),
            (
                events::REVIEW_ANNOTATIONS_CHANGED,
                serde_json::to_value(events::ReviewAnnotationsChanged {
                    review_id: "r".into(),
                    ts_ms: 0,
                })
                .unwrap(),
            ),
            (
                events::COMMENT_OFFER,
                serde_json::to_value(events::CommentOffer {
                    offer_id: "o".into(),
                    session_id: "s".into(),
                    block_id: None,
                    body: "b".into(),
                    agent_id: "a".into(),
                    ts_ms: 0,
                })
                .unwrap(),
            ),
            (
                events::LEDGER_CHANGED,
                serde_json::to_value(events::LedgerChanged { ts_ms: 0 }).unwrap(),
            ),
            (
                events::SUGGESTION_RESOLVED,
                serde_json::to_value(events::SuggestionResolved {
                    suggestion_id: "id".into(),
                    status: "applied".into(),
                    ts_ms: 0,
                })
                .unwrap(),
            ),
        ];
        for (name, value) in samples {
            let doc = docs::EVENT_DOCS.iter().find(|d| d.name == name).unwrap();
            let mut serialized: Vec<&str> =
                value.as_object().unwrap().keys().map(|k| k.as_str()).collect();
            let mut documented: Vec<&str> = doc.fields.iter().map(|(f, _, _)| *f).collect();
            serialized.sort_unstable();
            documented.sort_unstable();
            assert_eq!(serialized, documented, "field drift for {name}");
        }
    }

    #[test]
    fn every_scope_is_described() {
        for scope in scopes::KNOWN_SCOPES {
            assert!(
                scopes::describe(scope).is_some(),
                "scope {scope} has no plain-language description"
            );
        }
    }

    #[test]
    fn event_decode_round_trips_and_tolerates_unknown() {
        let payload = serde_json::to_string(&events::LedgerChanged { ts_ms: 42 }).unwrap();
        match events::Event::decode(events::LEDGER_CHANGED, &payload) {
            events::Event::LedgerChanged(p) => assert_eq!(p.ts_ms, 42),
            other => panic!("expected LedgerChanged, got {other:?}"),
        }
        match events::Event::decode("future.event", "{}") {
            events::Event::Unknown { name, .. } => assert_eq!(name, "future.event"),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn ptr_len_packing_round_trips() {
        for (ptr, len) in [(0u32, 0u32), (1, 7), (0xffff_fff0, 0x7fff_ffff)] {
            assert_eq!(abi::unpack_ptr_len(abi::pack_ptr_len(ptr, len)), (ptr, len));
        }
    }

    #[test]
    fn wit_names_the_core_surface() {
        // The IDL and the abi constants describe the same surface.
        for export in abi::GUEST_EXPORTS {
            assert!(WIT.contains(export), "WIT missing guest export {export}");
        }
        for import in [abi::HOST_CALL, abi::HOST_LOG] {
            assert!(WIT.contains(import), "WIT missing host import {import}");
        }
    }
}
