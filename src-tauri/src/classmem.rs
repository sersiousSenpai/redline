// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Polis ClassMemory (Phase 2): the agent-classified, human-curated, vectorless
//! class **catalog over the lake** built in Phase 1.
//!
//! The lake (`prompts` + `ledger_events`) is raw and never reorganized. This
//! module builds a *catalog* on top of it: `class_nodes` form an emergent tree
//! (repos seed roots; anything else earns class status by growing), and
//! `class_links` are pointers from a node into the lake. Reorganizing the tree
//! never touches the underlying data — it only moves nodes and re-parents
//! pointers.
//!
//! Everything the classifier produces is a **proposal**. Nothing enters or moves
//! in the tree without a user accept (Redline's review-everything ethos):
//!
//! - **Additive** proposals (`file`, `create`) stage directly as
//!   `status='proposed'` rows in `class_nodes` / `class_links`; accepting flips
//!   them to `accepted` and writes a `class_curate` ledger event.
//! - **Structural** proposals (`promote`, `split`, `merge`, `collapse`) operate
//!   on *existing accepted* nodes, so they queue in `class_proposals`; accepting
//!   applies the op to the tree and writes a `taxonomy_reorg` ledger event —
//!   "memory edits are part of the Polis record" (plan Decision #3).
//!
//! The classifier itself is spawned headless with `--strict-mcp-config`
//! preserved (read-only, proposals-only) and its structured-JSON output is
//! machine-parsed the same way the mission orchestrator's is.



use crate::db::Database;

#[allow(unused_imports)]
pub use polis_memory::organize::{CATALOG_SNAPSHOT_MAX_BYTES, CLASSIFIER_ACTOR, CLASSIFIER_ITEM_HEAD, CLASSIFIER_ITEM_TAIL, GENERAL_ROOT_ID, MAX_CORPUS_BYTES, MAX_DELTA_ITEMS, OrganizeOutcome, build_classifier_prompt, render_catalog_snapshot, root_id_for_path, seed_root_rows};


/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::organize::organize_once`; this reaches it through `polis_for`.
pub async fn organize_once(db: &Database) -> Result<OrganizeOutcome, String> {
    polis_memory::organize::organize_once(&crate::polis_host::polis_for(db)).await
}


// The pure vocabulary of ClassMemory — row types, the proposal grammar and the
// coldness interlock — lives in `polis-core` (Session A1 of the Polis
// extraction, docs/polis-extraction.md). Re-exported so every
// `crate::classmem::…` call site is unchanged.
// `#[allow(unused_imports)]`: a shim re-exports for PATH STABILITY, not for use
// inside this module — what nothing here touches still has call sites elsewhere
// (or in tests), and the lint cannot see across cfgs.
#[allow(unused_imports)]
pub use polis_core::coldness::{
    auto_collapse_safe, subtree_stats, BranchStat, LakeEnvelope, COLLAPSE_FRESH_FRACTION,
};
#[allow(unused_imports)]
pub use polis_core::proposal::{
    parse_proposals, parse_supersede_verdicts, Proposal, SplitPart, SupersedeVerdict,
    SUPERSEDE_CONFIDENCE_MIN,
};
#[allow(unused_imports)]
pub use polis_store::catalog::new_node_id;
#[allow(unused_imports)]
pub use polis_store::record::{record_curate, record_reorg, revert_link};
#[allow(unused_imports)]
pub use polis_core::types::{
    AppliedReorg, ClassLink, ClassNode, ClassObservation, ClassProposalRow, ClassRun, LakeItem,
    StageResult, StagedOutcome, SupersessionOutcome, DECISION_KINDS,
};

// ---------------------------------------------------------------------------
// Row types (mirrors of the class_* tables)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Staging (materialize parsed proposals as reviewable rows)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Classifier spawn + drive
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Catalog snapshot (baked into a retrieval agent's first turn)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// One organize pass (shared by the command + the background keeper)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Supersede verifier (the machine confidence gate)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Accept helpers (decision/reorg ledger events)
// ---------------------------------------------------------------------------

