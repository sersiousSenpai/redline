// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The verifiable export bundle: its wire shape and the verifier that
//! re-checks every event from the bundle alone (per-event `entry_hash`
//! recomputation; genesis→head re-walk for a contiguous full export). No
//! SQLite anywhere in this module — that is the point.

use serde::{Deserialize, Serialize};

use crate::ledger::{compute_entry_hash, CanonicalEvent, LedgerEventRow, GENESIS_PREV};
use crate::types::{ClassLink, ClassNode};

/// Bundle format identifier, bumped if the shape changes.
pub const BUNDLE_SCHEMA: &str = "redline.context-bundle/1";

/// What slice of the lake to export.
#[derive(Debug, Clone)]
pub enum BundleScope {
    /// One plan session's events + bodies (no tree).
    Session(String),
    /// One mission's captured prompts + their events (no tree).
    Mission(String),
    /// One class subtree: its nodes + links + the linked bodies + their events.
    Class(String),
    /// The entire lake + the whole ClassMemory tree. Re-verifies genesis→head.
    Full,
}

impl BundleScope {
    /// A stable label recorded in the bundle + the `plan_exports` row.
    pub fn label(&self) -> String {
        match self {
            BundleScope::Session(id) => format!("session:{id}"),
            BundleScope::Mission(id) => format!("mission:{id}"),
            BundleScope::Class(id) => format!("class:{id}"),
            BundleScope::Full => "full".to_string(),
        }
    }

    /// The short scope word stored in `plan_exports.scope`.
    pub fn kind(&self) -> &'static str {
        match self {
            BundleScope::Session(_) => "session",
            BundleScope::Mission(_) => "mission",
            BundleScope::Class(_) => "class",
            BundleScope::Full => "full",
        }
    }

    /// The session id this scope is *about*, if any (for F6 export bookkeeping).
    pub fn session_id(&self) -> Option<&str> {
        match self {
            BundleScope::Session(id) => Some(id.as_str()),
            _ => None,
        }
    }
}

/// A prompt body carried in a bundle (full body, not the 4000-char preview).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BundlePrompt {
    pub id: i64,
    pub body: String,
}

/// A revision body carried in a bundle (the markdown a `revision` event
/// references but does not own — snapshotted here for portability).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundleRevision {
    pub session_id: String,
    pub version_number: i64,
    pub markdown: String,
}

/// The ClassMemory slice carried in a class/full bundle.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BundleTree {
    pub nodes: Vec<ClassNode>,
    pub links: Vec<ClassLink>,
}

/// A user note/star row carried in a bundle (Second Brain P3) — the CURRENT
/// readable state; the act-by-act history rides along as `note` events. Kept
/// as its own snapshot struct (not `context::UserNote`) so the bundle wire
/// shape stays frozen independently of the app's internals.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundleNote {
    pub id: i64,
    pub seq: Option<i64>,
    pub target_kind: String,
    pub target_id: Option<String>,
    pub text: String,
    pub starred: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The whole export bundle. Ordering of every collection is deterministic (by
/// seq / id) so two exports of the same ledger state are byte-identical.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundle {
    pub schema: String,
    pub scope: String,
    /// The ledger head at export — the version this bundle is pinned to.
    pub head_hash: String,
    pub verified_at: i64,
    /// Ledger events (ascending by seq) — each self-certifying via `entry_hash`.
    pub events: Vec<LedgerEventRow>,
    pub prompts: Vec<BundlePrompt>,
    pub revisions: Vec<BundleRevision>,
    pub tree: BundleTree,
    /// User notes/stars in scope (P3). `default` so every pre-P3 bundle still
    /// deserializes — the addition is additive, which is why `BUNDLE_SCHEMA`
    /// stays at /1 (verification never reads this field).
    #[serde(default)]
    pub notes: Vec<BundleNote>,
}

/// The result of `verify_bundle`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundleVerdict {
    /// Every event re-hashes correctly, and (for a full chain) the recomputed
    /// head equals the pinned `head_hash`.
    pub ok: bool,
    /// How many events were checked.
    pub checked: usize,
    /// First seq whose recomputed hash disagreed, if any.
    pub first_bad_seq: Option<i64>,
    /// True when the bundle is a contiguous chain from seq 1 (a `full` export),
    /// so genesis→head linkage was also verified.
    pub full_chain: bool,
    /// The head hash recomputed from the bundle (the last event's `entry_hash`).
    pub recomputed_head: Option<String>,
}

/// Build the canonical (hashed) form of a stored event row.
pub fn canonical_of(row: &LedgerEventRow) -> CanonicalEvent<'_> {
    CanonicalEvent {
        seq: row.seq,
        ts: row.ts,
        kind: &row.kind,
        author: &row.author,
        prompt_id: row.prompt_id,
        session_id: row.session_id.as_deref(),
        version_number: row.version_number,
        ref_kind: row.ref_kind.as_deref(),
        ref_id: row.ref_id.as_deref(),
        payload_hash: &row.payload_hash,
    }
}


/// Verify a bundle **from the bundle alone** — no DB access. Recomputes each
/// event's `entry_hash`; for a contiguous full chain, also walks genesis→head
/// and confirms the recomputed head equals the pinned `head_hash`.
pub fn verify_bundle(bundle: &ContextBundle) -> BundleVerdict {
    let mut events = bundle.events.clone();
    events.sort_by_key(|e| e.seq);

    // Per-event tamper-evidence: stored entry_hash must recompute from its own
    // prev_hash + canonical fields. This holds even for a scoped subset.
    for e in &events {
        let recomputed = compute_entry_hash(&e.prev_hash, &canonical_of(e));
        if recomputed != e.entry_hash {
            return BundleVerdict {
                ok: false,
                checked: events.len(),
                first_bad_seq: Some(e.seq),
                full_chain: false,
                recomputed_head: None,
            };
        }
    }

    // Is this a contiguous chain from seq 1? Then it's a full export and we can
    // re-walk genesis→head.
    let full_chain = !events.is_empty()
        && events[0].seq == 1
        && events.windows(2).all(|w| w[1].seq == w[0].seq + 1);

    let recomputed_head = events.last().map(|e| e.entry_hash.clone());

    if full_chain {
        let mut prev = GENESIS_PREV.to_string();
        for e in &events {
            if e.prev_hash != prev {
                return BundleVerdict {
                    ok: false,
                    checked: events.len(),
                    first_bad_seq: Some(e.seq),
                    full_chain: true,
                    recomputed_head: None,
                };
            }
            prev = e.entry_hash.clone();
        }
        let head_ok = recomputed_head.as_deref() == Some(bundle.head_hash.as_str());
        return BundleVerdict {
            ok: head_ok,
            checked: events.len(),
            first_bad_seq: if head_ok { None } else { events.last().map(|e| e.seq) },
            full_chain: true,
            recomputed_head,
        };
    }

    // A scoped bundle: per-event integrity is the guarantee.
    BundleVerdict {
        ok: true,
        checked: events.len(),
        first_bad_seq: None,
        full_chain: false,
        recomputed_head,
    }
}
