// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The handlers. The first block is Redline's memory and context routes,
//! moved verbatim (Session A6) with their database calls rewritten onto the
//! [`MemoryApi`] — same query shapes, same response bodies, same status codes
//! (including the 502 `{error}` failure shape the browse routes gave them).
//! The second block is the plan's §4.4 additions.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use polis_core::api::{
    AnnotateRequest, BrowseRequest, ContextRequest, ForgetRequest, GrepRequest, IngestRequest,
    PromptsRequest, RememberRequest, Scope, SearchRequest, TreeRequest,
};
use polis_core::host::Change;
use polis_core::pack::budgeted_item_count;
use polis_core::proposal::parse_proposals;
use polis_core::types::{
    clamp_prompt_limit, GrepScope, LedgerFilters, PromptFilters, StageResult, MAX_DELTA_ITEMS,
};
use polis_core::{MemoryApi, MemoryError};

use crate::PolisState;

/// 502 with `{error}` — the failure shape these routes have always had (they
/// were born beside the browse routes and share it), kept so no consumer
/// sees a new code for an old failure.
pub(crate) fn error_response(msg: impl Into<String>) -> Response {
    (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}

/// A [`MemoryError`] as a response: a guardrail verdict is the caller's
/// mistake (400, with the reason — the agent's next move depends on reading
/// it), a missing thing is 404, a capability the install lacks is 503, and a
/// store fault keeps the routes' 502.
pub(crate) fn memory_error(e: MemoryError) -> Response {
    let (status, detail) = match e {
        MemoryError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
        MemoryError::Rejected(r) => (StatusCode::BAD_REQUEST, r),
        MemoryError::Unavailable(r) => (StatusCode::SERVICE_UNAVAILABLE, r),
        MemoryError::Store(r) => (StatusCode::BAD_GATEWAY, r),
    };
    (status, Json(serde_json::json!({ "error": detail }))).into_response()
}

// ===========================================================================
// Moved from Redline's lib.rs — the memory routes
// ===========================================================================

#[derive(Deserialize)]
pub struct MemoryTreeQ {
    project: Option<String>,
    root: Option<String>,
}

/// `GET /v1/memory/tree?project=&root=` — the accepted (and proposed) class tree,
/// flat with link counts (the caller/FE builds the hierarchy). Scoped to a single
/// root subtree when `root=<id>` or `project=<path>` is given. Read-only.
pub async fn handle_memory_tree(
    State(state): State<PolisState>,
    Query(q): Query<MemoryTreeQ>,
) -> Response {
    match state.api.tree(&TreeRequest { root: q.root, project: q.project, scope: Scope::default() }) {
        Ok(views) => Json(serde_json::json!({ "nodes": views })).into_response(),
        Err(e) => memory_error(e),
    }
}

/// `GET /v1/memory/node/:id` — one node, its children, its links (pointers
/// into the lake, with resolved labels + supersession status), and its
/// observations. The retrieval agent's descend step.
pub async fn handle_memory_node(
    State(state): State<PolisState>,
    Path(id): Path<String>,
) -> Response {
    match state.api.node(&id, &Scope::default()) {
        Ok(Some(view)) => Json(view).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "no such class node").into_response(),
        Err(e) => memory_error(e),
    }
}

#[derive(Deserialize)]
pub struct AnswerPackQ {
    q: Option<String>,
    node: Option<String>,
    limit: Option<i64>,
}

/// `GET /v1/memory/answer-pack?q=&node=&limit=` — the retrieval agent's ONE
/// call. Resolves the question to a class node (explicitly via `?node=`, else
/// by best title match) and returns that node's subtree, links (labelled, with
/// `supersededBy`) and observations, together with the user's matching notes,
/// matching lake prompts and matching browsed pages.
///
/// It replaces a 5–7 turn walk, so it must never send the agent back into one:
/// the lexical arms are populated from `?q=` regardless of whether a node
/// resolved, and a stale `?node=` degrades to the best match instead of an
/// empty answer. Read-only, byte-bounded.
pub async fn handle_memory_answer_pack(
    State(state): State<PolisState>,
    Query(q): Query<AnswerPackQ>,
) -> Response {
    let api = state.api.clone();
    let req = SearchRequest { q: q.q, node: q.node, limit: q.limit, scope: Scope::default() };
    // Assembly touches several tables under the DB lock — off the async
    // executor's thread, like every other heavy bridge read.
    let pack = tokio::task::spawn_blocking(move || api.search(&req)).await;
    match pack {
        Ok(Ok(pack)) => Json(pack).into_response(),
        Ok(Err(e)) => memory_error(e),
        Err(e) => error_response(format!("answer-pack assembly failed: {e}")),
    }
}

#[derive(Deserialize)]
pub struct MemoryGrepQ {
    q: Option<String>,
    re: Option<String>,
    case: Option<String>,
    scope: Option<String>,
    limit: Option<i64>,
}

/// `GET /v1/memory/grep?q=&re=&case=&scope=&limit=` — literal and regex search
/// over the record, for the things tokenization cannot reach: flags
/// (`--allowedTools`), paths (`src-tauri/src/db.rs`), error strings,
/// attributes (`#[serde(rename_all)]`).
///
/// `q` is a substring answered from a trigram index and must be at least
/// `GREP_MIN_LITERAL` characters — shorter is refused by name rather than
/// silently turned into a scan. `re` is applied in Rust to what the index
/// returned, so a pathological pattern costs one pass over the candidates
/// instead of a walk of the corpus under the DB lock.
pub async fn handle_memory_grep(
    State(state): State<PolisState>,
    Query(q): Query<MemoryGrepQ>,
) -> Response {
    let literal = q.q.unwrap_or_default();
    let case_sensitive = matches!(q.case.as_deref(), Some("1") | Some("true"));
    let scope = GrepScope::parse(q.scope.as_deref());
    let limit = q.limit.unwrap_or(30);
    let re = q.re;
    let api = state.api.clone();
    let hits = tokio::task::spawn_blocking(move || {
        api.grep(&GrepRequest {
            literal,
            regex: re,
            case_sensitive,
            kinds: scope,
            limit: Some(limit),
            scope: Scope::default(),
        })
    })
    .await;
    match hits {
        Ok(Ok(hits)) => Json(serde_json::json!({ "hits": hits })).into_response(),
        // A refusal is a 400 WITH its reason in the body: the agent's next move
        // ("lengthen the needle") is only available if it can read why.
        Ok(Err(e)) => memory_error(e),
        Err(e) => error_response(format!("grep failed: {e}")),
    }
}

#[derive(Deserialize)]
pub struct MemoryPromptsQ {
    since_seq: Option<i64>,
    limit: Option<i64>,
}

/// `GET /v1/memory/prompts?since_seq=&limit=` — the lake delta (prompts +
/// decision events) since a seq, oldest first. The classifier's delta input;
/// also a general context read. Bounded.
pub async fn handle_memory_prompts(
    State(state): State<PolisState>,
    Query(q): Query<MemoryPromptsQ>,
) -> Response {
    let limit = q.limit.unwrap_or(200).clamp(1, MAX_DELTA_ITEMS as i64);
    let since = q.since_seq.unwrap_or(0).max(0);
    match state.api.prompts(&PromptsRequest { since_seq: since, limit: Some(limit), scope: Scope::default() }) {
        Ok(mut items) => {
            // Byte-budget the response, the way `/v1/context/prompts` does.
            // The item count was capped but the BYTES were not, and this
            // route's body column is `COALESCE(p.body, be.text, un.text)` —
            // `be.text` is a whole normalized page, so 400 browse items could
            // serialize megabytes under the DB lock. The route is live on the
            // MCP proxy, so a remote caller could ask for that at will.
            let kept = budgeted_item_count(items.iter().map(|i| i.body.as_deref()));
            items.truncate(kept);
            Json(serde_json::json!({ "items": items })).into_response()
        }
        Err(e) => memory_error(e),
    }
}

/// `POST /v1/memory/proposals` {proposals:[…]} — stage a batch of classifier
/// proposals as reviewable rows. **Staging only** — nothing is accepted or
/// moved. Mirrors the parse the internal Organize path uses, so an external tool
/// (or the classifier itself) can stage over the curl bridge.
pub async fn handle_memory_proposals(
    State(state): State<PolisState>,
    body: axum::body::Bytes,
) -> Response {
    if body.len() > 256_000 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "proposals payload too large").into_response();
    }
    let text = String::from_utf8_lossy(&body);
    let proposals = parse_proposals(&text);
    if proposals.is_empty() {
        return Json(serde_json::json!({ "ok": true, "staged": StageResult::default() }))
            .into_response();
    }
    match state.api.stage_proposals(&proposals, "api") {
        Ok(staged) => {
            state.events.changed(&[Change::Catalog]);
            Json(serde_json::json!({ "ok": true, "staged": staged })).into_response()
        }
        Err(e) => memory_error(e),
    }
}

#[derive(Deserialize)]
pub struct ContextPromptsQ {
    session: Option<String>,
    mission: Option<String>,
    surface: Option<String>,
    project: Option<String>,
    since_seq: Option<i64>,
    /// Free-text substring — bound as a LIKE parameter in the DB layer.
    q: Option<String>,
    limit: Option<i64>,
    thread_kind: Option<String>,
    thread_id: Option<String>,
    parent_session: Option<String>,
    /// Exact-match filter on the recorded model (`prompts.model`).
    model: Option<String>,
    /// Corpus role: `user` (default view) | `agent` | `system`.
    role: Option<String>,
    /// Opt in to the host's own constructed prefaces, which are excluded by
    /// default. `1`/`true` to include.
    include_agent: Option<String>,
}

/// `GET /v1/context/prompts?session=&mission=&surface=&project=&since_seq=&q=&limit=&role=&include_agent=`
/// — filtered read of the captured-prompt lake. Every filter is ANDed; `q` is
/// planned through the FTS index (AND→OR→LIKE cascade). `agent` rows are
/// excluded unless asked for. Oldest-first, byte-bounded. Read-only.
pub async fn handle_context_prompts(
    State(state): State<PolisState>,
    Query(q): Query<ContextPromptsQ>,
) -> Response {
    let filters = PromptFilters {
        session_id: q.session,
        mission_id: q.mission,
        surface: q.surface,
        project: q.project,
        since_seq: q.since_seq,
        substring: q.q,
        limit: clamp_prompt_limit(q.limit),
        thread_kind: q.thread_kind,
        thread_id: q.thread_id,
        parent_session_id: q.parent_session,
        model: q.model,
        role: q.role,
        include_agent: matches!(q.include_agent.as_deref(), Some("1") | Some("true")),
    };
    match state.api.list_prompts(&filters, &Scope::default()) {
        Ok(items) => Json(serde_json::json!({ "items": items })).into_response(),
        Err(e) => memory_error(e),
    }
}

/// `GET /v1/context/stats` — aggregate counts (per day / surface / kind /
/// class / author). Read-only.
pub async fn handle_context_stats(State(state): State<PolisState>) -> Response {
    match state.api.stats(&Scope::default()) {
        Ok(stats) => Json(stats).into_response(),
        Err(e) => memory_error(e),
    }
}

#[derive(Deserialize)]
pub struct ContextThreadQ {
    limit: Option<i64>,
}

/// `GET /v1/context/threads/:kind/:id?limit=` — generic read-only fetch of any
/// surface's discussion thread (browse / linked / mission / companion / drafter
/// / a plan session's comment threads), tail-bounded, oldest-first.
pub async fn handle_context_thread(
    State(state): State<PolisState>,
    Path((kind, id)): Path<(String, String)>,
    Query(q): Query<ContextThreadQ>,
) -> Response {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    match state.api.thread(&kind, &id, limit, &Scope::default()) {
        Ok(Some(view)) => Json(view).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "unknown thread kind").into_response(),
        Err(e) => memory_error(e),
    }
}

/// `GET /v1/context/tree/:kind/:id` — one session-tree node with its parent and
/// child digests (message counts + recency), the traversable spine of
/// memory-by-session. Read-only.
pub async fn handle_context_tree(
    State(state): State<PolisState>,
    Path((kind, id)): Path<(String, String)>,
) -> Response {
    match state.api.thread_tree(&kind, &id, &Scope::default()) {
        Ok(tree) => Json(tree).into_response(),
        Err(e) => memory_error(e),
    }
}

#[derive(Deserialize)]
pub struct BrowseSearchQ {
    /// Free-text query — tokenized + quoted into a safe FTS5 MATCH in the DB.
    q: Option<String>,
    limit: Option<i64>,
}

/// `GET /v1/context/browse/search?q=&limit=` — lexical (BM25) search over
/// the browsing-behavior stream. High-volume, keyword-heavy browse events get
/// fuzzy full-text recall here (plans/prompts stay on the vectorless walk).
/// Read-only; returns `{items:[{id,ts,url,title,snippet,score}]}` best-first.
pub async fn handle_browse_search(
    State(state): State<PolisState>,
    Query(q): Query<BrowseSearchQ>,
) -> Response {
    let query = q.q.unwrap_or_default();
    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    match state.api.browse_search(&query, limit, &Scope::default()) {
        Ok(items) => Json(serde_json::json!({ "items": items })).into_response(),
        Err(e) => memory_error(e),
    }
}

// ===========================================================================
// New in A6 — the plan's §4.4 reads and writes
// ===========================================================================

#[derive(Deserialize)]
pub struct ContextQ {
    q: Option<String>,
    node: Option<String>,
    max_tokens: Option<usize>,
}

/// `GET /v1/memory/context?q=&node=&max_tokens=` — the answer pack rendered as
/// one grounding block (the discussion prefetch's shape), for a model to be
/// handed verbatim. `q` is required: the block is about a question.
pub async fn handle_memory_context(
    State(state): State<PolisState>,
    Query(q): Query<ContextQ>,
) -> Response {
    let Some(question) = q.q.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "q is required" })))
            .into_response();
    };
    let api = state.api.clone();
    let req = ContextRequest { q: question, node: q.node, max_tokens: q.max_tokens, scope: Scope::default() };
    match tokio::task::spawn_blocking(move || api.context(&req)).await {
        Ok(Ok(block)) => Json(block).into_response(),
        Ok(Err(e)) => memory_error(e),
        Err(e) => error_response(format!("context assembly failed: {e}")),
    }
}

/// The timeline's facets as a query string. `LedgerFilters` itself is the
/// command/IPC shape (a JSON body with a `seqs` array); a URL carries the
/// same axes flat, with `seqs` comma-separated.
#[derive(Deserialize)]
pub struct LedgerQ {
    kind: Option<String>,
    author: Option<String>,
    session: Option<String>,
    surface: Option<String>,
    project: Option<String>,
    q: Option<String>,
    since_ts: Option<i64>,
    until_ts: Option<i64>,
    before_seq: Option<i64>,
    limit: Option<i64>,
    starred: Option<String>,
    noted: Option<String>,
    seqs: Option<String>,
    class_node: Option<String>,
    thread_id: Option<String>,
    browse_id: Option<String>,
    role: Option<String>,
}

fn flag(v: Option<&str>) -> Option<bool> {
    matches!(v, Some("1") | Some("true")).then_some(true)
}

/// `GET /v1/memory/ledger?…` — a faceted timeline page, newest first; the next
/// page's cursor is the last row's seq as `before_seq`.
pub async fn handle_memory_ledger(
    State(state): State<PolisState>,
    Query(q): Query<LedgerQ>,
) -> Response {
    let seqs: Option<Vec<i64>> = q.seqs.map(|s| s.split(',').filter_map(|p| p.trim().parse().ok()).collect());
    let filters = LedgerFilters {
        kind: q.kind,
        author: q.author,
        session_id: q.session,
        surface: q.surface,
        project: q.project,
        q: q.q,
        since_ts: q.since_ts,
        until_ts: q.until_ts,
        before_seq: q.before_seq,
        limit: q.limit,
        starred: flag(q.starred.as_deref()),
        noted: flag(q.noted.as_deref()),
        seqs: seqs.filter(|v| !v.is_empty()),
        class_node: q.class_node,
        thread_id: q.thread_id,
        browse_id: q.browse_id,
        role: q.role,
    };
    let api = state.api.clone();
    match tokio::task::spawn_blocking(move || api.timeline(&filters, &Scope::default())).await {
        Ok(Ok(items)) => Json(serde_json::json!({ "items": items })).into_response(),
        Ok(Err(e)) => memory_error(e),
        Err(e) => error_response(format!("timeline query failed: {e}")),
    }
}

/// `GET /v1/memory/verify` — re-walk the chain genesis→head.
pub async fn handle_memory_verify(State(state): State<PolisState>) -> Response {
    let api = state.api.clone();
    match tokio::task::spawn_blocking(move || api.verify()).await {
        Ok(Ok(verdict)) => Json(verdict).into_response(),
        Ok(Err(e)) => memory_error(e),
        Err(e) => error_response(format!("verify failed: {e}")),
    }
}

/// `GET /v1/memory/health` — intactness and capability in one read. The
/// no-model install reports `model: null`; nothing here is an error state.
pub async fn handle_memory_health(State(state): State<PolisState>) -> Response {
    let api = state.api.clone();
    match tokio::task::spawn_blocking(move || api.health()).await {
        Ok(Ok(report)) => Json(report).into_response(),
        Ok(Err(e)) => memory_error(e),
        Err(e) => error_response(format!("health failed: {e}")),
    }
}

/// `GET /v1/memory/map` — classes + threads with declared edge kinds.
pub async fn handle_memory_map(State(state): State<PolisState>) -> Response {
    let api = state.api.clone();
    match tokio::task::spawn_blocking(move || api.map(&Scope::default())).await {
        Ok(Ok(map)) => Json(map).into_response(),
        Ok(Err(e)) => memory_error(e),
        Err(e) => error_response(format!("map failed: {e}")),
    }
}

/// 201 when the write appended a row, 200 when it was a no-op (a dedup, an
/// unchanged note) — the receipt says which either way.
fn write_response<T: serde::Serialize>(created: bool, receipt: T) -> Response {
    let status = if created { StatusCode::CREATED } else { StatusCode::OK };
    (status, Json(receipt)).into_response()
}

/// `POST /v1/memory/remember` — one memory: the user's own words as a prompt
/// row (`asUser`), or a standalone note.
pub async fn handle_memory_remember(
    State(state): State<PolisState>,
    Json(req): Json<RememberRequest>,
) -> Response {
    match state.api.remember(&req) {
        Ok(receipt) => {
            if receipt.seq.is_some() {
                state.events.changed(&[Change::Ledger]);
            }
            write_response(receipt.seq.is_some(), receipt)
        }
        Err(e) => memory_error(e),
    }
}

/// `POST /v1/memory/annotate` — a note on a seq, a node or a session.
pub async fn handle_memory_annotate(
    State(state): State<PolisState>,
    Json(req): Json<AnnotateRequest>,
) -> Response {
    match state.api.annotate(&req) {
        Ok(receipt) => {
            if receipt.seq.is_some() {
                state.events.changed(&[Change::Ledger]);
            }
            write_response(receipt.seq.is_some(), receipt)
        }
        Err(e) => memory_error(e),
    }
}

/// `POST /v1/memory/forget` — the one destructive verb. Refused (400) without
/// the literal `confirm: "forget"`.
pub async fn handle_memory_forget(
    State(state): State<PolisState>,
    Json(req): Json<ForgetRequest>,
) -> Response {
    match state.api.forget(&req) {
        Ok(receipt) => {
            if receipt.seq.is_some() {
                state.events.changed(&[Change::Ledger, Change::Memory]);
            }
            Json(receipt).into_response()
        }
        Err(e) => memory_error(e),
    }
}

/// `POST /v1/memory/events` — a batch import with its own clock, idempotent on
/// `(body hash, run)`.
pub async fn handle_memory_events(
    State(state): State<PolisState>,
    Json(req): Json<IngestRequest>,
) -> Response {
    match state.api.ingest(&req) {
        Ok(receipt) => {
            let created = !receipt.recorded.is_empty();
            if created {
                state.events.changed(&[Change::Ledger]);
            }
            write_response(created, receipt)
        }
        Err(e) => memory_error(e),
    }
}

/// `POST /v1/memory/browse` — one browsing event into the lake.
pub async fn handle_memory_browse(
    State(state): State<PolisState>,
    Json(req): Json<BrowseRequest>,
) -> Response {
    match state.api.browse(&req) {
        Ok(receipt) => {
            if receipt.seq.is_some() {
                state.events.changed(&[Change::Ledger]);
            }
            write_response(receipt.seq.is_some(), receipt)
        }
        Err(e) => memory_error(e),
    }
}

/// `POST /v1/memory/organize` — one classifier pass, now. Drives the model;
/// 503 when the install has none.
pub async fn handle_memory_organize(State(state): State<PolisState>) -> Response {
    match state.api.organize(&Scope::default()).await {
        Ok(receipt) => {
            if receipt.ran {
                state.events.changed(&[Change::Catalog, Change::Ledger]);
            }
            Json(receipt).into_response()
        }
        Err(e) => memory_error(e),
    }
}

/// `POST /v1/memory/reindex` — embed one call's worth of the semantic backlog.
pub async fn handle_memory_reindex(State(state): State<PolisState>) -> Response {
    let api = state.api.clone();
    match tokio::task::spawn_blocking(move || api.reindex(&Scope::default())).await {
        Ok(Ok(receipt)) => {
            if receipt.embedded > 0 {
                state.events.changed(&[Change::Embeddings]);
            }
            Json(receipt).into_response()
        }
        Ok(Err(e)) => memory_error(e),
        Err(e) => error_response(format!("reindex failed: {e}")),
    }
}

// The trait is named in the module docs; keep the import honest under
// `#![deny(unused)]`-style builds.
#[allow(dead_code)]
fn _uses_trait(_: &dyn MemoryApi) {}
