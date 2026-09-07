// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Building the verifiable export bundle (the verifier is `polis_core::bundle`). Lifted from Redline's `bundle.rs` in Session A5.

#[allow(unused_imports)]
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
#[allow(unused_imports)]
use std::path::{Path, PathBuf};

#[allow(unused_imports)]
use serde::{Deserialize, Serialize};
#[allow(unused_imports)]
use serde_json::Value;

#[allow(unused_imports)]
use polis_core::coldness::{auto_collapse_safe, subtree_stats, BranchStat, LakeEnvelope};
#[allow(unused_imports)]
use polis_core::ledger::{now_millis, EventKind, LedgerEventRow};
#[allow(unused_imports)]
use polis_core::pack::*;
#[allow(unused_imports)]
use polis_core::proposal::{parse_proposals, parse_supersede_verdicts, Proposal, SupersedeVerdict, SUPERSEDE_CONFIDENCE_MIN};
#[allow(unused_imports)]
use polis_core::types::*;
#[allow(unused_imports)]
use polis_store::record::{record_curate, record_reorg, revert_link, DecisionInput};
#[allow(unused_imports)]
use polis_store::PolisStore;

#[allow(unused_imports)]
use crate::agent::{run_classifier, run_keeper_summarizer};
#[allow(unused_imports)]
use crate::organize::AUTO_APPLY_KEY;
use crate::Polis;
#[allow(unused_imports)]
use polis_core::bundle::*;
#[allow(unused_imports)]
use polis_core::ledger::GENESIS_PREV;

/// Build a bundle for `scope`. Bodies are joined at build time (prompt →
/// `prompts.body`, revision → `revisions.raw_plan_markdown`); decision events
/// reference a row and carry no body. Pure read; ordering is deterministic.
pub fn build_bundle(polis: &Polis<'_>, scope: &BundleScope) -> Result<ContextBundle, String> {
    let db = polis.store;
    // The pinned head — the authoritative ledger head at export time.
    let head_hash = db
        .verify_ledger_chain()
        .map_err(|e| e.to_string())?
        .head_hash
        .unwrap_or_else(|| GENESIS_PREV.to_string());

    // Everything ascending; filter to scope. A long history is bounded by the
    // ledger's own size — an export is an explicit, user-driven action.
    let all = db
        .list_ledger_events_asc(0, i64::MAX)
        .map_err(|e| e.to_string())?;

    // Resolve which events belong to this scope, and (for class) the tree.
    let (mut events, tree): (Vec<LedgerEventRow>, BundleTree) = match scope {
        BundleScope::Full => (all, full_tree(polis)?),
        BundleScope::Session(sid) => (
            all.into_iter()
                .filter(|e| e.session_id.as_deref() == Some(sid.as_str()))
                .collect(),
            BundleTree::default(),
        ),
        BundleScope::Mission(mid) => {
            let ids: std::collections::HashSet<i64> =
                db.mission_prompt_ids(mid).map_err(|e| e.to_string())?.into_iter().collect();
            (
                all.into_iter()
                    .filter(|e| e.prompt_id.map(|id| ids.contains(&id)).unwrap_or(false))
                    .collect(),
                BundleTree::default(),
            )
        }
        BundleScope::Class(root) => {
            let (tree, keep) = class_scope(polis, root)?;
            (
                all.into_iter().filter(|e| keep.matches(e)).collect(),
                tree,
            )
        }
    };

    events.sort_by_key(|e| e.seq);

    // Join bodies for the events actually in the bundle.
    let mut prompts: Vec<BundlePrompt> = Vec::new();
    let mut seen_prompt = std::collections::HashSet::new();
    let mut revisions: Vec<BundleRevision> = Vec::new();
    let mut seen_rev = std::collections::HashSet::new();
    for e in &events {
        if e.kind == "prompt" {
            if let Some(pid) = e.prompt_id {
                if seen_prompt.insert(pid) {
                    if let Ok(Some(body)) = db.get_prompt_body(pid) {
                        prompts.push(BundlePrompt { id: pid, body });
                    }
                }
            }
        } else if e.kind == "revision" {
            if let (Some(sid), Some(ver)) = (e.session_id.as_deref(), e.version_number) {
                if seen_rev.insert((sid.to_string(), ver)) {
                    if let Ok(Some(md)) = polis.revision_markdown(sid, ver) {
                        revisions.push(BundleRevision {
                            session_id: sid.to_string(),
                            version_number: ver,
                            markdown: md,
                        });
                    }
                }
            }
        }
    }
    prompts.sort_by_key(|p| p.id);
    revisions.sort_by(|a, b| a.session_id.cmp(&b.session_id).then(a.version_number.cmp(&b.version_number)));

    // User notes in scope: everything for a full export; for scoped bundles,
    // the notes ON bundled events plus (session scope) the note on the session
    // itself. Standalone thoughts travel only in full bundles — they belong to
    // no narrower slice.
    let event_seqs: std::collections::HashSet<i64> = events.iter().map(|e| e.seq).collect();
    let mut notes: Vec<BundleNote> = db
        .list_user_notes(false, i64::MAX)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|n| match scope {
            BundleScope::Full => true,
            BundleScope::Session(sid) => {
                (n.target_kind == "session" && n.target_id.as_deref() == Some(sid.as_str()))
                    || (n.target_kind == "ledger_event"
                        && n.target_id
                            .as_deref()
                            .and_then(|t| t.parse::<i64>().ok())
                            .map(|s| event_seqs.contains(&s))
                            .unwrap_or(false))
            }
            _ => {
                n.target_kind == "ledger_event"
                    && n.target_id
                        .as_deref()
                        .and_then(|t| t.parse::<i64>().ok())
                        .map(|s| event_seqs.contains(&s))
                        .unwrap_or(false)
            }
        })
        .map(|n| BundleNote {
            id: n.id,
            seq: n.seq,
            target_kind: n.target_kind,
            target_id: n.target_id,
            text: n.text,
            starred: n.starred,
            created_at: n.created_at,
            updated_at: n.updated_at,
        })
        .collect();
    notes.sort_by_key(|n| n.id);

    Ok(ContextBundle {
        schema: BUNDLE_SCHEMA.to_string(),
        scope: scope.label(),
        head_hash,
        verified_at: now_millis(),
        events,
        prompts,
        revisions,
        tree,
        notes,
    })
}

/// The full ClassMemory tree (deterministically ordered).
pub fn full_tree(polis: &Polis<'_>) -> Result<BundleTree, String> {
    let db = polis.store;
    let mut nodes = db.list_class_nodes().map_err(|e| e.to_string())?;
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let mut links: Vec<ClassLink> = Vec::new();
    for n in &nodes {
        links.extend(db.list_class_links_for_node(&n.id).unwrap_or_default());
    }
    links.sort_by_key(|l| l.id);
    Ok(BundleTree { nodes, links })
}

/// Which events a class-scoped bundle keeps, resolved from the subtree's links.
pub struct ClassKeep {
    prompt_ids: std::collections::HashSet<i64>,
    session_ids: std::collections::HashSet<String>,
    seqs: std::collections::HashSet<i64>,
}

impl ClassKeep {
    fn matches(&self, e: &LedgerEventRow) -> bool {
        if self.seqs.contains(&e.seq) {
            return true;
        }
        if let Some(pid) = e.prompt_id {
            if self.prompt_ids.contains(&pid) {
                return true;
            }
        }
        if let Some(sid) = e.session_id.as_deref() {
            if self.session_ids.contains(sid) {
                return true;
            }
        }
        false
    }
}

/// Build the class subtree + the event-keep set from its links.
pub fn class_scope(polis: &Polis<'_>, root: &str) -> Result<(BundleTree, ClassKeep), String> {
    let db = polis.store;
    let all = db.list_class_nodes().map_err(|e| e.to_string())?;
    // Ids of root + all descendants (fixpoint over parent_id).
    let mut keep_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    keep_ids.insert(root.to_string());
    loop {
        let before = keep_ids.len();
        for n in &all {
            if let Some(p) = &n.parent_id {
                if keep_ids.contains(p) {
                    keep_ids.insert(n.id.clone());
                }
            }
        }
        if keep_ids.len() == before {
            break;
        }
    }
    let mut nodes: Vec<ClassNode> = all.into_iter().filter(|n| keep_ids.contains(&n.id)).collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));

    let mut links: Vec<ClassLink> = Vec::new();
    let mut keep = ClassKeep {
        prompt_ids: std::collections::HashSet::new(),
        session_ids: std::collections::HashSet::new(),
        seqs: std::collections::HashSet::new(),
    };
    for n in &nodes {
        for l in db.list_class_links_for_node(&n.id).unwrap_or_default() {
            match l.target_kind.as_str() {
                "prompt" => {
                    if let Ok(id) = l.target_id.parse::<i64>() {
                        keep.prompt_ids.insert(id);
                    }
                }
                "session" | "revision" => {
                    keep.session_ids.insert(l.target_id.clone());
                }
                "decision" | "ledger" => {
                    if let Ok(seq) = l.target_id.parse::<i64>() {
                        keep.seqs.insert(seq);
                    }
                }
                _ => {}
            }
            links.push(l);
        }
    }
    links.sort_by_key(|l| l.id);
    Ok((BundleTree { nodes, links }, keep))
}
