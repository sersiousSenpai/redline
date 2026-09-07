// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Coldness, scoped: the temporal + storage facts that let a branch be judged
//! cold against the lake's OWN activity envelope (never wall-clock), and the
//! interlock that stops a fresh or pinned branch from being auto-collapsed.

use std::collections::HashMap;

use crate::types::ClassNode;

/// Subtree-rolled activity for one branch — the *temporal + storage* facts that
/// give "cold" a scope. `last_ts` is the newest resolvable linked lake item in
/// the whole subtree; `item_count` is how many links it holds; `pinned` is true
/// if the node or any descendant is pinned (an absolute anti-decay veto).
#[derive(Debug, Clone, Default)]
pub struct BranchStat {
    pub last_ts: Option<i64>,
    pub item_count: i64,
    pub pinned: bool,
}

/// The lake's temporal envelope: the oldest and newest ledger `ts`. Coldness is
/// measured against *this* (the lake's own activity), never wall-clock — Redline
/// may be closed for weeks, so the newest event is the true "now".
#[derive(Debug, Clone, Copy)]
pub struct LakeEnvelope {
    pub oldest: i64,
    pub newest: i64,
}

impl LakeEnvelope {
    pub fn span(&self) -> i64 {
        (self.newest - self.oldest).max(0)
    }
}

/// Safety interlock on the one destructive, auto-applied op. A branch is safe to
/// **auto**-collapse only when its most-recent activity sits outside the freshest
/// slice of the lake's span. This is NOT a taxonomy threshold (the orchestrator
/// still judges *what* is cold) — it's a floor that stops silent destruction of
/// recently-touched data. Anything that fails this (pinned, too fresh, or no
/// datable history to judge) is held as a pending proposal for manual review.
/// Tunable: the fraction of the lake span that counts as "too fresh to auto-nuke".
pub const COLLAPSE_FRESH_FRACTION: f64 = 0.34;

/// Whether a branch may be auto-collapsed (see `COLLAPSE_FRESH_FRACTION`).
pub fn auto_collapse_safe(stat: &BranchStat, env: LakeEnvelope) -> bool {
    if stat.pinned {
        return false; // pins are an absolute anti-decay veto
    }
    let Some(last) = stat.last_ts else {
        return false; // no datable activity → can't judge coldness → hold for review
    };
    let span = env.span();
    if span <= 0 {
        return false; // not enough history to have a notion of cold
    }
    let age = (env.newest - last).max(0) as f64;
    age >= COLLAPSE_FRESH_FRACTION * span as f64
}

/// Roll up per-node direct activity (`node_id → (item_count, last_ts)`) into
/// subtree stats for every node, folding in the pin flags. Pure / testable.
pub fn subtree_stats(
    nodes: &[ClassNode],
    direct: &HashMap<String, (i64, Option<i64>)>,
) -> HashMap<String, BranchStat> {
    // children index
    let mut kids: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, n) in nodes.iter().enumerate() {
        if let Some(p) = &n.parent_id {
            kids.entry(p.clone()).or_default().push(i);
        }
    }
    let pinned_of: HashMap<&str, bool> = nodes.iter().map(|n| (n.id.as_str(), n.pinned)).collect();

    // Recursive rollup with a visited guard (defensive against cycles).
    fn roll(
        idx: usize,
        nodes: &[ClassNode],
        kids: &HashMap<String, Vec<usize>>,
        pinned_of: &HashMap<&str, bool>,
        direct: &HashMap<String, (i64, Option<i64>)>,
        out: &mut HashMap<String, BranchStat>,
        depth: usize,
    ) -> BranchStat {
        let id = &nodes[idx].id;
        let (mut count, mut last) = direct.get(id).copied().unwrap_or((0, None));
        let mut pinned = *pinned_of.get(id.as_str()).unwrap_or(&false);
        if depth < 64 {
            if let Some(children) = kids.get(id) {
                for &c in children {
                    let cs = roll(c, nodes, kids, pinned_of, direct, out, depth + 1);
                    count += cs.item_count;
                    last = match (last, cs.last_ts) {
                        (Some(a), Some(b)) => Some(a.max(b)),
                        (a, b) => a.or(b),
                    };
                    pinned = pinned || cs.pinned;
                }
            }
        }
        let stat = BranchStat { last_ts: last, item_count: count, pinned };
        out.insert(id.clone(), stat.clone());
        stat
    }

    let mut out = HashMap::new();
    for (i, n) in nodes.iter().enumerate() {
        if n.parent_id.is_none() {
            roll(i, nodes, &kids, &pinned_of, direct, &mut out, 0);
        }
    }
    // Any node not reached from a root (orphaned parent) still gets its direct stat.
    for n in nodes {
        out.entry(n.id.clone()).or_insert_with(|| {
            let (count, last) = direct.get(&n.id).copied().unwrap_or((0, None));
            BranchStat { last_ts: last, item_count: count, pinned: n.pinned }
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtree_stats_rolls_up_counts_recency_and_pins() {
        let n = |id: &str, parent: Option<&str>, pinned: bool| ClassNode {
            id: id.into(),
            parent_id: parent.map(str::to_string),
            kind: "node".into(),
            title: id.into(),
            summary: None,
            project_path: None,
            ip_name: None,
            status: "accepted".into(),
            pinned,
            curated_by: None,
            created_at: 0,
            updated_at: 0,
        };
        let nodes = vec![
            n("root", None, false),
            n("child", Some("root"), true), // a pinned descendant
        ];
        let mut direct = HashMap::new();
        direct.insert("root".to_string(), (1i64, Some(100i64)));
        direct.insert("child".to_string(), (2i64, Some(900i64)));
        let stats = subtree_stats(&nodes, &direct);
        let root = &stats["root"];
        assert_eq!(root.item_count, 3); // 1 + 2 from child
        assert_eq!(root.last_ts, Some(900)); // newest across subtree
        assert!(root.pinned, "a pinned descendant makes the branch pinned");
    }

    #[test]
    fn auto_collapse_interlock_holds_pinned_fresh_and_undatable() {
        let env = LakeEnvelope { oldest: 0, newest: 1000 };
        // Old, unpinned, datable → safe to auto-collapse.
        assert!(auto_collapse_safe(
            &BranchStat { last_ts: Some(100), item_count: 5, pinned: false },
            env
        ));
        // Pinned → held regardless of age.
        assert!(!auto_collapse_safe(
            &BranchStat { last_ts: Some(100), item_count: 5, pinned: true },
            env
        ));
        // Too fresh (within the freshest slice) → held.
        assert!(!auto_collapse_safe(
            &BranchStat { last_ts: Some(900), item_count: 5, pinned: false },
            env
        ));
        // No datable activity → can't judge → held.
        assert!(!auto_collapse_safe(
            &BranchStat { last_ts: None, item_count: 5, pinned: false },
            env
        ));
    }
}
