// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The [`MemoryApi`] trait — the ONE surface Polis exposes.
//!
//! `polis-server` routes over `Arc<dyn MemoryApi>`, `polis-mcp` exposes it as
//! tools, the generated Python/TypeScript clients call the routes, and the
//! `Polis` handle in `polis-memory` implements it over the store. Redline's
//! handlers become thin callers of the same methods. One trait, so the four
//! transports cannot drift from one another or from the store.
//!
//! The methods are synchronous on purpose: the store is a SQLite connection
//! under a mutex, and every transport today calls it inline (Redline's axum
//! handlers do exactly this). An async transport wraps a call in
//! `spawn_blocking`; a sync trait keeps the surface object-safe with no
//! `async_trait` machinery and no runtime dependency in this crate.
//!
//! Defined in Session A1; bound by the `Polis` handle in A5 and served in A6
//! (`docs/polis-extraction.md`). Every read takes a [`Scope`], which is empty
//! until identity lands (E2) — the shape is fixed now so no transport has to
//! change its signature then.

use serde::{Deserialize, Serialize};

use std::future::Future;
use std::pin::Pin;

use crate::ledger::{ChainVerdict, Origin};
use crate::pack::AnswerPack;
use crate::proposal::Proposal;
use crate::types::{
    BrowseHit, ClassLink, ClassNode, ClassObservation, ContextStats, GrepHit, GrepScope,
    LakeItem, LedgerFilters, MemoryMapView, PromptFilters, StageResult, TimelineItem,
};

/// The one asynchronous return in the surface: a boxed, `Send` future, so the
/// trait stays object-safe with no `async_trait` dependency in this crate.
/// Only [`MemoryApi::organize`] uses it — it drives a model, and a model turn
/// is the one thing here that cannot be answered inline.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Who is asking, and over whose memory. Every field is optional: an empty
/// scope is "this principal, everything local", which is all a solo install
/// ever has. `include_shared` widens a read to imported foreign chains once
/// sharing lands (E3); it is never the default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Scope {
    pub principal: Option<String>,
    pub org: Option<String>,
    pub agent: Option<String>,
    pub run: Option<String>,
    pub project: Option<String>,
    pub include_shared: bool,
}

/// Why a call did not produce a value. `Rejected` is a guardrail verdict
/// (data, never a fault); `Unavailable` names a capability the install lacks
/// (no model, no embedder) rather than pretending it ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum MemoryError {
    NotFound,
    Rejected(String),
    Unavailable(String),
    Store(String),
}

impl std::fmt::Display for MemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemoryError::NotFound => write!(f, "not found"),
            MemoryError::Rejected(r) => write!(f, "rejected: {r}"),
            MemoryError::Unavailable(r) => write!(f, "unavailable: {r}"),
            MemoryError::Store(r) => write!(f, "store: {r}"),
        }
    }
}

impl std::error::Error for MemoryError {}

// ---------------------------------------------------------------------------
// Read requests and views
// ---------------------------------------------------------------------------

/// `memory_search` / `GET /v1/memory/answer-pack`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchRequest {
    pub q: Option<String>,
    /// An explicit node to resolve instead of resolving from `q`.
    pub node: Option<String>,
    pub limit: Option<i64>,
    pub scope: Scope,
}

/// `memory_grep` / `GET /v1/memory/grep`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GrepRequest {
    pub literal: String,
    pub regex: Option<String>,
    pub case_sensitive: bool,
    pub kinds: GrepScope,
    pub limit: Option<i64>,
    pub scope: Scope,
}

/// `memory_tree` / `GET /v1/memory/tree`: the catalog, optionally one root
/// (by id, or by the project path bound to it).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TreeRequest {
    pub root: Option<String>,
    pub project: Option<String>,
    pub scope: Scope,
}

/// One catalog node with its filed-link count — the tree route's row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodeView {
    #[serde(flatten)]
    pub node: ClassNode,
    pub link_count: i64,
}

/// One link with its lake label and supersession status resolved — the same
/// `(label, supersededBy)` decoration the answer pack carries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    #[serde(flatten)]
    pub link: ClassLink,
    pub label: Option<String>,
    /// The decision seq that superseded this link's target (`None` = current).
    /// Distinct from `link.status`, which stays proposed|accepted.
    pub superseded_by: Option<i64>,
}

/// `memory_node` / `GET /v1/memory/node/:id`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    pub node: ClassNode,
    pub children: Vec<ClassNode>,
    pub links: Vec<LinkView>,
    pub observations: Vec<ClassObservation>,
}

/// `GET /v1/memory/prompts`: the lake in chain order from a seq.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptsRequest {
    pub since_seq: i64,
    pub limit: Option<i64>,
    pub scope: Scope,
}

// ---------------------------------------------------------------------------
// Write requests and receipts
// ---------------------------------------------------------------------------

/// `memory_remember`: one memory the user (or, with `as_user = false`, an
/// agent on their behalf) wants kept — a standalone note, or a prompt row.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RememberRequest {
    pub text: String,
    /// Record as the user's own words (`role = user`). `false` files it as
    /// agent text, which the lexical index and the classifier treat as such.
    pub as_user: bool,
    pub project: Option<String>,
    pub scope: Scope,
}

/// One episode/message in a batch `memory_ingest`. `ts` is the moment it
/// happened (an import carries its own clock); `None` means now.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IngestItem {
    pub body: String,
    pub ts: Option<i64>,
    /// `user` | `agent` | `system`; defaults to `user`.
    pub role: Option<String>,
    pub session: Option<String>,
    pub run: Option<String>,
    pub project: Option<String>,
}

/// `memory_ingest` / `POST /v1/memory/events`: idempotent on
/// `(body_hash, run)` — replaying a batch records nothing twice.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IngestRequest {
    pub items: Vec<IngestItem>,
    pub scope: Scope,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestReceipt {
    /// Ledger seqs recorded, in batch order (skipped items are absent).
    pub recorded: Vec<i64>,
    pub skipped: usize,
}

/// `memory_annotate`: a note on a seq or a node.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AnnotateRequest {
    /// `ledger_event | class_node | session | none`.
    pub target_kind: String,
    pub target_id: Option<String>,
    pub text: String,
    pub scope: Scope,
}

/// `memory_forget`: the body goes to `[forgotten]`, its archive, vectors and
/// claims are removed, and the chain stays green (it commits to the hash, not
/// the text). `confirm` must be the literal `"forget"` — the tool is marked
/// destructive and a transport must not be able to trip it by accident.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ForgetRequest {
    /// `prompt | browse_event | note | claim`.
    pub target_kind: String,
    pub target_id: String,
    pub confirm: String,
    pub scope: Scope,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetReceipt {
    pub forgotten: bool,
    /// The compaction/redaction event appended, when one was.
    pub seq: Option<i64>,
}

/// `memory_supersede`: a newer decision replaces an older one on the same
/// subject. Never deletes — the old decision stays in the lake.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupersedeRequest {
    pub old_seq: i64,
    pub new_seq: i64,
    pub rationale: Option<String>,
    pub scope: Scope,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupersedeReceipt {
    pub applied: bool,
    /// The seq actually superseded (may differ from `old_seq` when redirected
    /// to the head of its chain).
    pub effective_old: Option<i64>,
    pub event_seq: Option<i64>,
    /// The guardrail's reason when `applied` is false.
    pub rejected: Option<String>,
}

/// What a single write did: the ledger seq it appended and, when the write
/// created or resolved a side-table row, that row's id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReceipt {
    pub seq: Option<i64>,
    pub id: Option<i64>,
}

/// `GET /v1/memory/context`: the answer pack rendered as ONE grounding block
/// a model can be handed verbatim (the discussion prefetch's shape), budgeted
/// by `max_tokens` (default 2000, ~4 bytes a token).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextRequest {
    pub q: String,
    /// An explicit node to resolve instead of resolving from `q`.
    pub node: Option<String>,
    pub max_tokens: Option<usize>,
    pub scope: Scope,
}

/// The rendered block, or `None` when the record has nothing on the question
/// (rendered as absence on purpose — the block is honest about itself, and an
/// empty block would read as "searched and found nothing" either way).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBlock {
    pub text: Option<String>,
    /// The terms the plan actually searched for — what the block is about.
    pub terms: Vec<String>,
}

/// One turn of a host-side conversation thread (`/v1/memory/threads` today,
/// `/v1/context/threads/:kind/:id` in Redline): the host owns the message
/// tables and answers through `HostResolver::thread_messages`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub role: String,
    pub body: String,
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Capture, browse, maintenance
// ---------------------------------------------------------------------------

/// The capture hook's row (`POST /v1/prompts/ingest`): what the user typed
/// into a session, recorded as a `hook`-sourced prompt with the role the
/// corpus classifier assigns it. Distinct from [`IngestRequest`] on purpose:
/// that is an import with its own clock and provenance; this is live capture
/// and keeps the exact row shape the hook always produced.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub body: String,
    /// Whether the session ran in a project the host tracks (`Redline`) or
    /// anywhere else (`External`) — the host's `IngestObserver` decides.
    pub origin: Origin,
    /// `pty` | `external` (the origin's surface name, as recorded).
    pub surface: String,
    /// The harness session id the hook payload carried.
    pub session: Option<String>,
    /// The session's working directory.
    pub project: Option<String>,
}

/// `POST /v1/memory/browse`: one browsing event (a page came on screen, text
/// was selected, a form was submitted, the page was left) into the lake.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowseRequest {
    /// `navigate` | `select` | `submit` | `leave`; defaults to `navigate`.
    pub action: Option<String>,
    /// The tab's thread key, so events group per tab.
    pub browse_id: Option<String>,
    pub url: String,
    pub title: Option<String>,
    /// Normalized on-screen content (hashed; retained for lexical retrieval).
    pub text: String,
    /// Who performed the act: absent is the local human; an agent driving the
    /// tab passes its seat name.
    pub author: Option<String>,
    pub scope: Scope,
}

/// `POST /v1/memory/organize`: what one classifier pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeReceipt {
    /// False when the lake delta was empty and the classifier never ran.
    pub ran: bool,
    pub auto_applied: bool,
    pub summary: String,
    pub seq_from: i64,
    pub seq_to: i64,
    pub staged: StageResult,
}

/// `POST /v1/memory/reindex`: how much of the semantic backlog one call
/// embedded, and with what. `provider = "absent"` and `embedded = 0` is the
/// no-embedder state — reported, never an error.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexReceipt {
    pub embedded: usize,
    pub provider: String,
}

/// `GET /v1/memory/health`: is the record intact and what is the install
/// able to do. `model: None` is the no-model state (R12) — the deterministic
/// tiers still run and this reports it rather than erroring.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// The chain verdict's `ok`, lifted for a one-glance read.
    pub ok: bool,
    pub chain: ChainVerdict,
    pub head_seq: i64,
    pub total_prompts: i64,
    pub class_nodes: i64,
    /// The model backend's name, or `None` for no model.
    pub model: Option<String>,
    /// The semantic arm's provider kind (`absent` when none).
    pub embedder: String,
    pub schema_version: Option<String>,
    pub lexical_version: Option<String>,
}

// ---------------------------------------------------------------------------
// The trait
// ---------------------------------------------------------------------------

/// The ONE surface. Reads are pure functions of the store; writes append to
/// the chain. Object-safe (`Arc<dyn MemoryApi>` is how the server and the MCP
/// server hold it).
pub trait MemoryApi: Send + Sync {
    // --- reads ------------------------------------------------------------

    /// The answer pack: one batched read (node + links + notes + lexical +
    /// semantic + grep, RRF-fused, byte-budgeted).
    fn search(&self, req: &SearchRequest) -> Result<AnswerPack, MemoryError>;
    /// Literal / regex hits over the trigram index.
    fn grep(&self, req: &GrepRequest) -> Result<Vec<GrepHit>, MemoryError>;
    /// The catalog (optionally one root), each node with its link count.
    fn tree(&self, req: &TreeRequest) -> Result<Vec<TreeNodeView>, MemoryError>;
    /// One node with its children, decorated links and observations.
    fn node(&self, id: &str, scope: &Scope) -> Result<Option<NodeView>, MemoryError>;
    /// The lake in chain order from a seq — what the classifier is fed.
    fn prompts(&self, req: &PromptsRequest) -> Result<Vec<LakeItem>, MemoryError>;
    /// A faceted timeline page, newest first.
    fn timeline(&self, filters: &LedgerFilters, scope: &Scope) -> Result<Vec<TimelineItem>, MemoryError>;
    /// Aggregate counts per day / surface / kind / class / author.
    fn stats(&self, scope: &Scope) -> Result<ContextStats, MemoryError>;
    /// The memory map: classes + threads with declared edge kinds.
    fn map(&self, scope: &Scope) -> Result<MemoryMapView, MemoryError>;
    /// Re-walk the chain genesis→head.
    fn verify(&self) -> Result<ChainVerdict, MemoryError>;
    /// The filtered lake read (`GET /v1/context/prompts`): every filter ANDed,
    /// `substring` planned through the lexical index, byte-bounded.
    fn list_prompts(&self, filters: &PromptFilters, scope: &Scope) -> Result<Vec<LakeItem>, MemoryError>;
    /// Lexical (BM25) search over the browsing stream.
    fn browse_search(&self, q: &str, limit: i64, scope: &Scope) -> Result<Vec<BrowseHit>, MemoryError>;
    /// One session-tree node with its parent and child digests — the
    /// traversable spine of memory-by-session. The shape is the route's JSON.
    fn thread_tree(&self, kind: &str, id: &str, scope: &Scope) -> Result<serde_json::Value, MemoryError>;
    /// A host thread's tail, byte-bounded, with its label:
    /// `{kind, id, label, messages}`. `None` for a kind the host has no table
    /// for (the route 404s).
    fn thread(&self, kind: &str, id: &str, limit: i64, scope: &Scope) -> Result<Option<serde_json::Value>, MemoryError>;
    /// The answer pack rendered as one grounding block.
    fn context(&self, req: &ContextRequest) -> Result<ContextBlock, MemoryError>;
    /// Intactness and capability in one read.
    fn health(&self) -> Result<HealthReport, MemoryError>;

    // --- writes -----------------------------------------------------------

    /// The capture hook's row. `Ok(None)` is the store's own dedup (same body
    /// already the newest row of that session) — nothing written.
    fn capture(&self, req: &CaptureRequest) -> Result<Option<i64>, MemoryError>;
    fn remember(&self, req: &RememberRequest) -> Result<WriteReceipt, MemoryError>;
    fn ingest(&self, req: &IngestRequest) -> Result<IngestReceipt, MemoryError>;
    fn annotate(&self, req: &AnnotateRequest) -> Result<WriteReceipt, MemoryError>;
    fn forget(&self, req: &ForgetRequest) -> Result<ForgetReceipt, MemoryError>;
    fn supersede(&self, req: &SupersedeRequest) -> Result<SupersedeReceipt, MemoryError>;
    /// Stage parsed proposals into the gardener's queue under the same
    /// adjudication as its own — `POST /v1/memory/proposals`.
    fn stage_proposals(&self, proposals: &[Proposal], actor: &str) -> Result<StageResult, MemoryError>;
    /// One browsing event into the lake. `seq: None` is the per-tab
    /// consecutive-duplicate suppression — nothing written.
    fn browse(&self, req: &BrowseRequest) -> Result<WriteReceipt, MemoryError>;

    // --- maintenance ------------------------------------------------------

    /// One classifier pass over the lake delta, now. The one asynchronous
    /// method (it drives the model); `Unavailable` when no model is configured.
    fn organize(&self, scope: &Scope) -> BoxFuture<'_, Result<OrganizeReceipt, MemoryError>>;
    /// Embed one call's worth of the semantic backlog.
    fn reindex(&self, scope: &Scope) -> Result<ReindexReceipt, MemoryError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The trait must stay object-safe: the transports hold `dyn MemoryApi`.
    #[test]
    fn memory_api_is_object_safe() {
        fn takes(_: &dyn MemoryApi) {}
        let _: fn(&dyn MemoryApi) = takes;
    }

    #[test]
    fn scope_defaults_to_the_local_principal_and_omits_shared() {
        let s: Scope = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Scope::default());
        assert!(!s.include_shared, "shared reads are never the default");
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["includeShared"], false);
        assert!(v["principal"].is_null());
    }

    #[test]
    fn forget_needs_the_literal_confirmation_word_in_its_shape() {
        let r: ForgetRequest =
            serde_json::from_str(r#"{"targetKind":"prompt","targetId":"12"}"#).unwrap();
        assert_eq!(r.confirm, "", "absent confirmation is not confirmation");
    }

    #[test]
    fn the_new_receipts_report_absence_as_data_not_error() {
        let h = HealthReport::default();
        assert_eq!(h.model, None, "no model is a state, not a fault");
        let r: ReindexReceipt = serde_json::from_str(r#"{"embedded":0,"provider":"absent"}"#).unwrap();
        assert_eq!(r.provider, "absent");
        let b: BrowseRequest = serde_json::from_str(r#"{"url":"https://x","text":"t"}"#).unwrap();
        assert_eq!(b.action, None, "defaults to navigate at the store");
        let c: ContextRequest = serde_json::from_str(r#"{"q":"postgres"}"#).unwrap();
        assert_eq!(c.max_tokens, None);
        let v = serde_json::to_value(ThreadMessage { role: "user".into(), body: "b".into(), created_at: 5 }).unwrap();
        assert_eq!(v["createdAt"], 5, "the host row's camelCase shape");
    }

    #[test]
    fn errors_serialize_as_tagged_data() {
        let e = MemoryError::Rejected("different subjects".into());
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"kind":"rejected","detail":"different subjects"}"#
        );
        assert_eq!(e.to_string(), "rejected: different subjects");
    }
}
