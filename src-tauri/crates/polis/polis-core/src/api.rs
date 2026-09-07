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

use crate::ledger::ChainVerdict;
use crate::pack::AnswerPack;
use crate::proposal::Proposal;
use crate::types::{
    ClassLink, ClassNode, ClassObservation, ContextStats, GrepHit, GrepScope, LakeItem,
    LedgerFilters, MemoryMapView, StageResult, TimelineItem,
};

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

    // --- writes -----------------------------------------------------------

    fn remember(&self, req: &RememberRequest) -> Result<WriteReceipt, MemoryError>;
    fn ingest(&self, req: &IngestRequest) -> Result<IngestReceipt, MemoryError>;
    fn annotate(&self, req: &AnnotateRequest) -> Result<WriteReceipt, MemoryError>;
    fn forget(&self, req: &ForgetRequest) -> Result<ForgetReceipt, MemoryError>;
    fn supersede(&self, req: &SupersedeRequest) -> Result<SupersedeReceipt, MemoryError>;
    /// Stage parsed proposals into the gardener's queue under the same
    /// adjudication as its own — `POST /v1/memory/proposals`.
    fn stage_proposals(&self, proposals: &[Proposal], actor: &str) -> Result<StageResult, MemoryError>;
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
    fn errors_serialize_as_tagged_data() {
        let e = MemoryError::Rejected("different subjects".into());
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"kind":"rejected","detail":"different subjects"}"#
        );
        assert_eq!(e.to_string(), "rejected: different subjects");
    }
}
