// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `polis-server` — the HTTP surface of Polis Memory.
//!
//! One [`router`] over `Arc<dyn MemoryApi>`, and the [`ROUTES`] table it is
//! made from. The table is load-bearing three ways: a host's auth middleware
//! keys on it (Redline maps every row into its own frozen `/v1` contract and
//! fails closed on anything not in a table), the generated API page renders
//! from it, and the typed Python/TypeScript clients are generated from it
//! (G2). A test pins the table to the router's registrations so the three can
//! never drift from the fourth.
//!
//! Every handler takes `State<PolisState>`; a host whose state is richer
//! provides `FromRef<HostState> for PolisState` and calls
//! `Router::merge(polis_server::router())`. The handlers themselves are the
//! ones Redline served for a year, moved verbatim onto the [`MemoryApi`]
//! calls (Session A6 of the Polis extraction, `docs/polis-extraction.md`).
//!
//! The capture route (`POST /v1/prompts/ingest`, [`ingest`]) is the one route
//! with host-shaped behaviour around it; it asks its [`IngestObserver`] at
//! every fork and records through the same `MemoryApi`. The installer for
//! the hook that calls it is [`hook::CaptureHookSpec`]. Behind the
//! `standalone` feature, [`standalone`] binds the router itself under a
//! bearer-token guard for the `polis` daemon.

pub mod hook;
pub mod ingest;
pub mod routes;
#[cfg(feature = "standalone")]
pub mod standalone;

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

pub use polis_core::host::{GardenerEvents, IngestObserver, NoIngestObserver};
pub use polis_core::MemoryApi;

pub use ingest::{ingest_prompt_text, HttpHeaders};

/// What the handlers hold: the surface, the capture observer, and where a
/// write's "something changed" goes (the same bus the gardener reports on, so
/// a host's UI sees a route write exactly as it sees a gardener pass).
#[derive(Clone)]
pub struct PolisState {
    pub api: Arc<dyn MemoryApi>,
    pub ingest: Arc<dyn IngestObserver>,
    pub events: Arc<dyn GardenerEvents>,
}

impl PolisState {
    /// A state that observes nothing and notifies nobody — the standalone
    /// daemon's, and every test's.
    pub fn bare(api: Arc<dyn MemoryApi>) -> Self {
        Self {
            api,
            ingest: Arc::new(NoIngestObserver),
            events: Arc::new(polis_core::host::NoHost),
        }
    }
}

/// How a route is guarded. A host maps these onto its own classes; the
/// standalone server enforces them directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteClass {
    /// No credential: the read-only surface.
    Open,
    /// No credential *by design*, even though it writes: the globally
    /// installed capture hook fires from sessions nobody spawned with a
    /// secret. The route is fail-open and records only what the hook sends.
    HookContract,
    /// Bearer token required, carrying the named scope.
    Write(&'static str),
}

/// One row of the surface. `path` is the axum pattern exactly as registered
/// (`MatchedPath` returns the same string, which is what makes a middleware
/// lookup exact rather than fuzzy).
#[derive(Debug, Clone, Copy)]
pub struct RouteSpec {
    pub method: &'static str,
    pub path: &'static str,
    pub class: RouteClass,
    pub purpose: &'static str,
    pub request: &'static str,
    pub response: &'static str,
}

/// The write scopes, one per capability. Spelled identically to the host's
/// scope vocabulary (Redline's `redline-extension-abi` pins the equality) so
/// an extension token granted `memory.propose` there is `memory.propose` here.
pub mod scopes {
    /// Stage reviewable catalog proposals (never accepts or moves a node).
    pub const MEMORY_PROPOSE: &str = "memory.propose";
    /// Append to the record: remember, annotate, import events, browse events.
    pub const MEMORY_WRITE: &str = "memory.write";
    /// Forget a body. Its own scope: the tool is destructive, and a token
    /// that may write must not thereby be able to erase.
    pub const MEMORY_FORGET: &str = "memory.forget";
    /// Run the organizer or the semantic indexer now (spends the model / CPU).
    pub const MEMORY_ORGANIZE: &str = "memory.organize";

    pub const ALL: &[&str] = &[MEMORY_PROPOSE, MEMORY_WRITE, MEMORY_FORGET, MEMORY_ORGANIZE];
}

use scopes::*;

/// The surface, in router registration order.
pub const ROUTES: &[RouteSpec] = &[
    RouteSpec {
        method: "POST",
        path: "/v1/prompts/ingest",
        class: RouteClass::HookContract,
        purpose: "Polis lake capture: the global UserPromptSubmit hook POSTs its stdin payload (fail-open)",
        request: "JSON hook payload (prompt, session, cwd)",
        response: "200 always (never blocks the hook)",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/tree",
        class: RouteClass::Open,
        purpose: "ClassMemory catalog tree (retrieval walk entry point)",
        request: "—",
        response: "JSON class tree",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/node/:id",
        class: RouteClass::Open,
        purpose: "One ClassMemory node with members",
        request: "node id in path",
        response: "JSON node detail",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/prompts",
        class: RouteClass::Open,
        purpose: "Prompts under a class (retrieval leaf read)",
        request: "?class= node id",
        response: "JSON prompt list",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/answer-pack",
        class: RouteClass::Open,
        purpose: "Batched retrieval read: node + subtree + links + notes + lexical hits in one call",
        request: "?q= term, ?node= node id, ?limit= n",
        response: "JSON answer pack (byte-bounded)",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/grep",
        class: RouteClass::Open,
        purpose: "Literal/regex search over the record — flags, paths, error strings, attributes",
        request: "?q= literal (>= 3 chars, required), ?re= regex, ?case=1, ?scope=prompts/browse/all, ?limit= n",
        response: "JSON {hits:[{kind, seq, ts, label, excerpt}]}; 400 with a reason when the literal is too short",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/memory/proposals",
        class: RouteClass::Write(MEMORY_PROPOSE),
        purpose: "Stage reviewable ClassMemory proposal rows (never accepts or moves a node)",
        request: "JSON structured proposal ops",
        response: "JSON staged proposal ids",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/context",
        class: RouteClass::Open,
        purpose: "The answer pack rendered as ONE grounding block a model can be handed verbatim (the discussion prefetch's shape)",
        request: "?q= question (required), ?node= node id, ?max_tokens= n (default 2000)",
        response: "JSON {text: markdown block or null, terms:[searched terms]}",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/ledger",
        class: RouteClass::Open,
        purpose: "Faceted timeline page over the chain, newest first (cursor: before_seq)",
        request: "?kind=&author=&session=&surface=&project=&q=&since_ts=&until_ts=&before_seq=&limit=&starred=1&noted=1&seqs=1,2&class_node=&thread_id=&browse_id=&role=",
        response: "JSON {items:[timeline item, …]}",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/verify",
        class: RouteClass::Open,
        purpose: "Re-walk the hash chain genesis→head",
        request: "—",
        response: "JSON chain verdict {ok, checked, firstBadSeq, headHash}",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/health",
        class: RouteClass::Open,
        purpose: "Intactness and capability in one read: chain verdict, head seq, counts, the model (null = no model), the embedder, store versions",
        request: "—",
        response: "JSON health report",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/map",
        class: RouteClass::Open,
        purpose: "The memory map: classes + threads with declared edge kinds",
        request: "—",
        response: "JSON {nodes, edges}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/memory/remember",
        class: RouteClass::Write(MEMORY_WRITE),
        purpose: "Keep one memory: the user's own words (asUser) as a prompt row, or a standalone note",
        request: "JSON {text, asUser?, project?}",
        response: "JSON {seq, id}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/memory/annotate",
        class: RouteClass::Write(MEMORY_WRITE),
        purpose: "A note on a ledger seq, a class node or a session",
        request: "JSON {targetKind, targetId?, text}",
        response: "JSON {seq, id}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/memory/forget",
        class: RouteClass::Write(MEMORY_FORGET),
        purpose: "Body → `[forgotten]`; archive, vectors and claims removed; the chain stays green. Requires confirm:\"forget\"",
        request: "JSON {targetKind, targetId, confirm:\"forget\"}",
        response: "JSON {forgotten, seq}; 400 without the confirmation word",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/memory/events",
        class: RouteClass::Write(MEMORY_WRITE),
        purpose: "Batch import of episodes/messages with their own clock; idempotent on (body hash, run)",
        request: "JSON {items:[{body, ts?, role?, session?, run?, project?}]}",
        response: "JSON {recorded:[seq, …], skipped}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/memory/browse",
        class: RouteClass::Write(MEMORY_WRITE),
        purpose: "One browsing event (navigate / select / submit / leave) into the lake",
        request: "JSON {action?, browseId?, url, title?, text, author?}",
        response: "JSON {seq} (null = consecutive duplicate for the tab)",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/memory/organize",
        class: RouteClass::Write(MEMORY_ORGANIZE),
        purpose: "Run one classifier pass over the lake delta now (drives the model; 503 when no model is configured)",
        request: "— (empty body)",
        response: "JSON {ran, autoApplied, summary, seqFrom, seqTo, staged}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/memory/reindex",
        class: RouteClass::Write(MEMORY_ORGANIZE),
        purpose: "Embed one call's worth of the semantic backlog",
        request: "— (empty body)",
        response: "JSON {embedded, provider} (provider \"absent\" = no embedder, never an error)",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/prompts",
        class: RouteClass::Open,
        purpose: "Filtered lake query (bounded, injection-safe LIKE)",
        request: "?q=&project=&limit=...",
        response: "JSON prompt rows",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/stats",
        class: RouteClass::Open,
        purpose: "Aggregate lake/catalog stats",
        request: "—",
        response: "JSON stats",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/browse/search",
        class: RouteClass::Open,
        purpose: "Search captured browsing history",
        request: "?q=...",
        response: "JSON hits",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/threads/:kind/:id",
        class: RouteClass::Open,
        purpose: "Generic read of any per-surface message thread (memory-by-session spine)",
        request: "kind + id in path",
        response: "JSON message list",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/tree/:kind/:id",
        class: RouteClass::Open,
        purpose: "Session-tree walk: a node with parent + child digests",
        request: "kind + id in path",
        response: "JSON tree node",
    },
];

/// Look up the row for a request. `path` must be the registered axum pattern
/// (from `MatchedPath`), not the concrete URL.
pub fn route_spec(path: &str, method: &str) -> Option<&'static RouteSpec> {
    ROUTES.iter().find(|s| s.path == path && s.method == method)
}

/// The router, generic over the host's state: a host provides
/// `PolisState: FromRef<S>` and merges this into its own `Router<S>`; the
/// standalone server uses `S = PolisState`.
///
/// Registration order is [`ROUTES`]' order; `routes_match_router_registrations`
/// pins the two together.
pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PolisState: axum::extract::FromRef<S>,
{
    Router::new()
        // Polis prompt store: the global UserPromptSubmit capture hook POSTs
        // its stdin payload here. Fail-open by design — never 500s the hook.
        .route("/v1/prompts/ingest", post(ingest::handle_prompts_ingest))
        // ClassMemory: read-only catalog access for retrieval agents (the
        // class-router walk) + a staging-only proposals sink. Nothing here
        // accepts or moves a node — POST /proposals only stages rows.
        .route("/v1/memory/tree", get(routes::handle_memory_tree))
        .route("/v1/memory/node/:id", get(routes::handle_memory_node))
        .route("/v1/memory/prompts", get(routes::handle_memory_prompts))
        // The batched read: one call in place of the tree→node→search walk.
        .route("/v1/memory/answer-pack", get(routes::handle_memory_answer_pack))
        .route("/v1/memory/grep", get(routes::handle_memory_grep))
        .route("/v1/memory/proposals", post(routes::handle_memory_proposals))
        // The plan's §4.4 reads: the rendered grounding block, the faceted
        // timeline, the chain verdict, health, the map.
        .route("/v1/memory/context", get(routes::handle_memory_context))
        .route("/v1/memory/ledger", get(routes::handle_memory_ledger))
        .route("/v1/memory/verify", get(routes::handle_memory_verify))
        .route("/v1/memory/health", get(routes::handle_memory_health))
        .route("/v1/memory/map", get(routes::handle_memory_map))
        // …and its writes. Every one appends to the chain; `forget` is the one
        // destructive verb and carries its own scope.
        .route("/v1/memory/remember", post(routes::handle_memory_remember))
        .route("/v1/memory/annotate", post(routes::handle_memory_annotate))
        .route("/v1/memory/forget", post(routes::handle_memory_forget))
        .route("/v1/memory/events", post(routes::handle_memory_events))
        .route("/v1/memory/browse", post(routes::handle_memory_browse))
        .route("/v1/memory/organize", post(routes::handle_memory_organize))
        .route("/v1/memory/reindex", post(routes::handle_memory_reindex))
        // Context access: the read-only query surface over the lake for agents
        // (internal via curl, external via MCP). Filtered prompts, aggregate
        // stats, browse search. All bounded, injection-safe (`q` is planned
        // through the index, never spliced).
        .route("/v1/context/prompts", get(routes::handle_context_prompts))
        .route("/v1/context/stats", get(routes::handle_context_stats))
        .route("/v1/context/browse/search", get(routes::handle_browse_search))
        // Memory-by-session (spine): generic read-only thread fetch across the
        // host's per-surface message tables, and the session-tree walk (a node
        // with its parent + child digests).
        .route("/v1/context/threads/:kind/:id", get(routes::handle_context_thread))
        .route("/v1/context/tree/:kind/:id", get(routes::handle_context_tree))
}

#[cfg(test)]
pub(crate) mod testing {
    //! A real state over an in-memory store, shared by the route tests.
    use super::*;
    use polis_core::host::NoHost;
    use polis_memory::polis_llm::NoopSink;
    use polis_memory::polis_store::PolisStore;
    use polis_memory::PolisHandle;

    pub fn state() -> PolisState {
        let handle = PolisHandle::new(
            Arc::new(PolisStore::open_in_memory().unwrap()),
            None,
            Arc::new(NoHost),
            Arc::new(NoopSink),
        );
        PolisState::bare(Arc::new(handle))
    }

    pub fn app() -> Router {
        router::<PolisState>().with_state(state())
    }

    pub fn app_with(state: PolisState) -> Router {
        router::<PolisState>().with_state(state)
    }

    /// A concrete URL for a route pattern, for the coverage sweep.
    pub fn concrete(path: &str) -> String {
        path.replace(":kind", "session").replace(":id", "x")
    }

    /// A body the route's JSON extractor accepts, so the sweep proves the
    /// route exists rather than tripping a 422 on an empty body.
    pub fn body_for(path: &str) -> &'static str {
        match path {
            "/v1/prompts/ingest" => r#"{"prompt":"sweep","session_id":"s","cwd":"/tmp"}"#,
            "/v1/memory/proposals" => r#"{"proposals":[]}"#,
            "/v1/memory/remember" => r#"{"text":"kept","asUser":true}"#,
            "/v1/memory/annotate" => r#"{"targetKind":"none","text":"note"}"#,
            "/v1/memory/forget" => r#"{"targetKind":"prompt","targetId":"1","confirm":"forget"}"#,
            "/v1/memory/events" => r#"{"items":[{"body":"imported"}]}"#,
            "/v1/memory/browse" => r#"{"url":"https://example.test","text":"page"}"#,
            _ => "",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const LIB_SRC: &str = include_str!("lib.rs");

    /// Every string literal that immediately follows a `.route(` in this file
    /// — deliberately dumb, the same scrape Redline's own drift test uses.
    fn registered_route_paths() -> Vec<String> {
        let mut paths = Vec::new();
        // Only the router fn's body: this file also holds these tests, whose
        // own `.route(` literal must not count as a registration.
        let start = LIB_SRC.find("pub fn router<S>()").expect("the router fn");
        let end = LIB_SRC[start..].find("\n}\n").expect("the router fn's end") + start;
        let mut rest = &LIB_SRC[start..end];
        while let Some(idx) = rest.find(".route(") {
            rest = &rest[idx + ".route(".len()..];
            let Some(q1) = rest.find('"') else { break };
            let after = &rest[q1 + 1..];
            let Some(q2) = after.find('"') else { break };
            paths.push(after[..q2].to_string());
            rest = &after[q2..];
        }
        paths
    }

    #[test]
    fn routes_match_router_registrations() {
        let registered: Vec<String> = registered_route_paths();
        assert!(!registered.is_empty(), "found no .route( registrations — extraction broke");
        let mut table: Vec<String> = ROUTES.iter().map(|s| s.path.to_string()).collect();
        table.dedup();
        assert_eq!(
            registered, table,
            "ROUTES drifted from the router — same paths, same order, or the generated clients and a host's auth table lie"
        );
    }

    #[test]
    fn routes_have_no_duplicate_method_path_pairs_and_only_known_scopes() {
        let mut seen = std::collections::BTreeSet::new();
        for spec in ROUTES {
            assert!(seen.insert((spec.method, spec.path)), "duplicate row {} {}", spec.method, spec.path);
            if let RouteClass::Write(scope) = spec.class {
                assert!(scopes::ALL.contains(&scope), "{} {} uses an unlisted scope {scope}", spec.method, spec.path);
            }
        }
        assert_eq!(route_spec("/v1/memory/forget", "POST").unwrap().class, RouteClass::Write(scopes::MEMORY_FORGET));
        assert_eq!(route_spec("/v1/prompts/ingest", "POST").unwrap().class, RouteClass::HookContract);
        assert!(route_spec("/v1/memory/tree", "POST").is_none(), "method is part of the key");
    }

    /// Every row is served by the router with its declared method: a real
    /// request through the real handlers over an in-memory store, and none
    /// of them answers 404 or 405.
    #[tokio::test]
    async fn every_route_in_the_table_is_served() {
        let app = testing::app();
        for spec in ROUTES {
            let uri = testing::concrete(spec.path);
            let body = testing::body_for(spec.path);
            let req = Request::builder()
                .method(spec.method)
                .uri(&uri)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            let resp = app.clone().oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            // A handler's own 404 carries a reason ("no such class node",
            // "unknown thread kind"); the router's fallback 404 is empty.
            let unrouted = (status == StatusCode::NOT_FOUND && bytes.is_empty())
                || status == StatusCode::METHOD_NOT_ALLOWED;
            assert!(
                !unrouted,
                "{} {} is in ROUTES but the router answered {status}",
                spec.method,
                spec.path
            );
        }
    }

    async fn json_of(resp: axum::response::Response) -> (StatusCode, serde_json::Value) {
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v = if bytes.is_empty() { serde_json::Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::String(String::from_utf8_lossy(&bytes).into())) };
        (status, v)
    }

    /// The moved reads keep their shapes: `{nodes}`, `{items}`, `{hits}`, the
    /// node 404 text, the grep 400 with its reason.
    #[tokio::test]
    async fn the_moved_reads_keep_their_response_shapes() {
        let app = testing::app();
        let get = |uri: &str| Request::builder().uri(uri).body(Body::empty()).unwrap();
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/tree")).await.unwrap()).await;
        assert_eq!((s, v["nodes"].is_array()), (StatusCode::OK, true));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/node/nope")).await.unwrap()).await;
        assert_eq!((s, v.as_str()), (StatusCode::NOT_FOUND, Some("no such class node")));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/prompts")).await.unwrap()).await;
        assert_eq!((s, v["items"].is_array()), (StatusCode::OK, true));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/grep?q=ab")).await.unwrap()).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().contains("3"), "the reason names the floor: {v}");
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/grep?q=abcd")).await.unwrap()).await;
        assert_eq!((s, v["hits"].is_array()), (StatusCode::OK, true));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/context/prompts?limit=5")).await.unwrap()).await;
        assert_eq!((s, v["items"].is_array()), (StatusCode::OK, true));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/context/stats")).await.unwrap()).await;
        assert_eq!((s, v["totalPrompts"].clone()), (StatusCode::OK, serde_json::json!(0)));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/context/threads/browse/t1")).await.unwrap()).await;
        assert_eq!((s, v.as_str()), (StatusCode::NOT_FOUND, Some("unknown thread kind")), "NoHost has no thread tables");
        let (s, v) = json_of(app.clone().oneshot(get("/v1/context/tree/session/s1")).await.unwrap()).await;
        assert_eq!((s, v["node"]["kind"].clone()), (StatusCode::OK, serde_json::json!("session")));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/answer-pack?q=postgres")).await.unwrap()).await;
        assert_eq!((s, v["promptHits"].is_array()), (StatusCode::OK, true));
    }

    /// The new writes round-trip through the router and the chain stays
    /// green; `forget` refuses without the word; `organize` is 503 with no
    /// model; `reindex` and `health` report absence as data.
    #[tokio::test]
    async fn the_new_routes_write_read_and_report_absence() {
        let app = testing::app();
        let post = |uri: &str, body: &str| {
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let get = |uri: &str| Request::builder().uri(uri).body(Body::empty()).unwrap();

        let (s, v) = json_of(app.clone().oneshot(post("/v1/memory/remember", r#"{"text":"we chose postgres","asUser":true}"#)).await.unwrap()).await;
        assert_eq!((s, v["seq"].clone()), (StatusCode::CREATED, serde_json::json!(1)));
        let (s, v) = json_of(app.clone().oneshot(post("/v1/memory/events", r#"{"items":[{"body":"imported one","run":"r1"},{"body":"imported one","run":"r1"}]}"#)).await.unwrap()).await;
        assert_eq!((s, v["recorded"].clone(), v["skipped"].clone()), (StatusCode::CREATED, serde_json::json!([2]), serde_json::json!(1)));
        let (s, v) = json_of(app.clone().oneshot(post("/v1/memory/annotate", r#"{"targetKind":"ledger_event","targetId":"1","text":"the decision"}"#)).await.unwrap()).await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
        let (s, v) = json_of(app.clone().oneshot(post("/v1/memory/browse", r#"{"url":"https://example.test/a","title":"Example","text":"Example page body"}"#)).await.unwrap()).await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
        assert!(v["seq"].is_number());

        let (s, v) = json_of(app.clone().oneshot(post("/v1/memory/forget", r#"{"targetKind":"prompt","targetId":"1","confirm":"yes"}"#)).await.unwrap()).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
        let (s, v) = json_of(app.clone().oneshot(post("/v1/memory/forget", r#"{"targetKind":"prompt","targetId":"1","confirm":"forget"}"#)).await.unwrap()).await;
        assert_eq!((s, v["forgotten"].clone()), (StatusCode::OK, serde_json::json!(true)));

        let (s, v) = json_of(app.clone().oneshot(post("/v1/memory/organize", "")).await.unwrap()).await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE, "no model → 503, {v}");
        let (s, v) = json_of(app.clone().oneshot(post("/v1/memory/reindex", "")).await.unwrap()).await;
        assert_eq!((s, v["provider"].clone()), (StatusCode::OK, serde_json::json!("absent")));

        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/verify")).await.unwrap()).await;
        assert_eq!((s, v["ok"].clone()), (StatusCode::OK, serde_json::json!(true)));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/health")).await.unwrap()).await;
        assert_eq!((s, v["ok"].clone(), v["model"].clone()), (StatusCode::OK, serde_json::json!(true), serde_json::Value::Null));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/ledger?limit=10&kind=prompt")).await.unwrap()).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert!(v["items"].is_array());
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/map")).await.unwrap()).await;
        assert_eq!((s, v["nodes"].is_array()), (StatusCode::OK, true));
        let (s, v) = json_of(app.clone().oneshot(get("/v1/memory/context?q=postgres")).await.unwrap()).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert!(v["terms"].is_array());
        let (s, _) = json_of(app.clone().oneshot(get("/v1/memory/context")).await.unwrap()).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "q is required");
        let (s, v) = json_of(app.clone().oneshot(get("/v1/context/browse/search?q=Example")).await.unwrap()).await;
        assert_eq!((s, v["items"].as_array().map(|a| a.len())), (StatusCode::OK, Some(1)));
    }
}
