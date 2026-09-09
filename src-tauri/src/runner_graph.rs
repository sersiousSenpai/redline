// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Native run graph. The shadow-apply reducer, immutable identities, patch-key
//! allowlists and inverse batches are harvested/adapted from feature/app-map's
//! pure diagram.rs; none of that branch's surfaces or runtime are imported.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunNode {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub plan_block_id: Option<String>,
    #[serde(default)]
    pub seat: Option<String>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub scope_hint: Vec<String>,
    #[serde(default)]
    pub enforce_scope: bool,
    #[serde(default)]
    pub verify_cmd: Option<String>,
    /// Explicitly scoped checks opt out. Root checks default to a global barrier.
    #[serde(default = "yes")]
    pub check_global: bool,
    #[serde(default = "pending")]
    pub status: String,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default = "two")]
    pub max_attempts: u32,
    #[serde(default)]
    pub child_session_id: Option<String>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub meter: Option<Value>,
    #[serde(default)]
    pub attempt_meters: Vec<Value>,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub queued_messages: Vec<String>,
    #[serde(default)]
    pub position: Option<Point>,
}
fn yes() -> bool {
    true
}
fn pending() -> String {
    "pending".into()
}
fn two() -> u32 {
    2
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub edge_type: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunGraph {
    #[serde(default)]
    pub pause_reason: Option<String>,
    pub run_id: String,
    #[serde(default)]
    pub plan_session_id: Option<String>,
    pub project_path: String,
    pub status: String,
    pub rev: i64,
    pub max_write_parallel: u32,
    pub nodes: Vec<RunNode>,
    pub edges: Vec<RunEdge>,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunClaim {
    pub path: String,
    pub node_id: String,
    pub claimed_at: i64,
    pub released_at: Option<i64>,
}

pub fn live(status: &str) -> bool {
    matches!(status, "running" | "verifying")
}
pub fn satisfied(status: &str) -> bool {
    matches!(status, "passed" | "skipped")
}
pub fn terminal(status: &str) -> bool {
    matches!(status, "passed" | "failed" | "skipped")
}
fn id_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 120
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn validate(doc: &RunGraph) -> Result<(), String> {
    if !id_ok(&doc.run_id) || doc.project_path.trim().is_empty() {
        return Err("run id and project path are required".into());
    }
    if !["draft", "ready", "running", "paused", "done", "abandoned"].contains(&doc.status.as_str())
    {
        return Err("unknown run status".into());
    }
    if !(1..=16).contains(&doc.max_write_parallel) {
        return Err("maxWriteParallel must be 1..16".into());
    }
    if doc.nodes.len() > 128 || doc.edges.len() > 512 {
        return Err("run exceeds graph size limit".into());
    }
    let mut ids = HashSet::new();
    for n in &doc.nodes {
        if !id_ok(&n.id) || !ids.insert(n.id.as_str()) {
            return Err(format!("invalid or duplicate node {}", n.id));
        }
        if !["task", "check", "review", "gate"].contains(&n.kind.as_str()) {
            return Err(format!("unknown node kind {}", n.kind));
        }
        if n.title.trim().is_empty() || n.brief.len() > 64 * 1024 {
            return Err(format!("invalid title/brief for {}", n.id));
        }
        if ![
            "pending",
            "running",
            "verifying",
            "passed",
            "failed",
            "awaiting_human",
            "skipped",
        ]
        .contains(&n.status.as_str())
        {
            return Err("unknown node status".into());
        }
        if !(1..=10).contains(&n.max_attempts) {
            return Err("maxAttempts must be 1..10".into());
        }
        if n.kind == "check" && n.verify_cmd.as_deref().unwrap_or("").trim().is_empty() {
            return Err(format!("check {} needs verifyCmd", n.id));
        }
        if n.enforce_scope && n.scope_hint.is_empty() {
            return Err(format!("{} enforces an empty scope", n.id));
        }
        if n.scope_hint.len() > 64 || n.scope_hint.iter().any(|s| s.len() > 1024) {
            return Err("scope hints exceed limits".into());
        }
        if n.scope_hint
            .iter()
            .any(|s| s.starts_with('/') || s.split('/').any(|p| p == ".."))
        {
            return Err("scope hints must be repository relative".into());
        }
        if n.kind == "task" && n.backend.as_deref().is_some_and(|b| b != "claude") {
            return Err("only the Claude task backend is available".into());
        }
        if n.position
            .as_ref()
            .is_some_and(|p| !p.x.is_finite() || !p.y.is_finite())
        {
            return Err("nonfinite position".into());
        }
    }
    let mut edge_ids = HashSet::new();
    let mut endpoint_keys = HashSet::new();
    let mut degree: HashMap<&str, usize> = ids.iter().map(|s| (*s, 0)).collect();
    for e in &doc.edges {
        if !id_ok(&e.id) || !edge_ids.insert(&e.id) {
            return Err("duplicate or invalid edge id".into());
        }
        if !ids.contains(e.from.as_str()) || !ids.contains(e.to.as_str()) || e.from == e.to {
            return Err(format!("edge {} has invalid endpoints", e.id));
        }
        if !["blocks", "parent-child"].contains(&e.edge_type.as_str()) {
            return Err("unknown edge type".into());
        }
        if !endpoint_keys.insert((&e.from, &e.to, &e.edge_type)) {
            return Err("duplicate edge endpoints".into());
        }
        // Parent-child is provenance, but it must not introduce a cycle either.
        *degree.get_mut(e.to.as_str()).unwrap() += 1;
    }
    let mut ready: Vec<&str> = degree
        .iter()
        .filter_map(|(id, d)| (*d == 0).then_some(*id))
        .collect();
    let mut seen = 0;
    while let Some(id) = ready.pop() {
        seen += 1;
        for e in doc.edges.iter().filter(|e| e.from == id) {
            let d = degree.get_mut(e.to.as_str()).unwrap();
            *d -= 1;
            if *d == 0 {
                ready.push(e.to.as_str());
            }
        }
    }
    if seen != doc.nodes.len() {
        return Err("run graph contains a cycle".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RunOp {
    AddNode {
        node: RunNode,
    },
    UpdateNode {
        id: String,
        set: Map<String, Value>,
    },
    RemoveNode {
        id: String,
    },
    AddEdge {
        edge: RunEdge,
    },
    UpdateEdge {
        id: String,
        set: Map<String, Value>,
    },
    RemoveEdge {
        id: String,
    },
    SetParallelism {
        value: u32,
    },
    MoveNode {
        id: String,
        #[serde(rename = "beforeId", default)]
        before_id: Option<String>,
    },
}
#[derive(Debug, Clone, Serialize)]
pub struct Applied {
    pub doc: RunGraph,
    pub inverses: Vec<RunOp>,
    pub warnings: Vec<String>,
}
const NODE_PATCH_KEYS: &[&str] = &[
    "kind",
    "title",
    "brief",
    "planBlockId",
    "seat",
    "backend",
    "model",
    "effort",
    "scopeHint",
    "enforceScope",
    "verifyCmd",
    "checkGlobal",
    "maxAttempts",
    "position",
];
fn patch(
    current: Value,
    set: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(Value, Map<String, Value>), String> {
    let mut obj = current
        .as_object()
        .cloned()
        .ok_or("patch requires object")?;
    let mut inverse = Map::new();
    for (k, v) in set {
        if !allowed.contains(&k.as_str()) {
            return Err(format!("immutable or unknown patch key {k}"));
        }
        inverse.insert(k.clone(), obj.get(k).cloned().unwrap_or(Value::Null));
        if v.is_null() {
            obj.remove(k);
        } else {
            obj.insert(k.clone(), v.clone());
        }
    }
    Ok((Value::Object(obj), inverse))
}
/// All-or-nothing shadow application. Inverses are already in undo order.
pub fn apply(doc: &RunGraph, base_rev: i64, ops: &[RunOp]) -> Result<Applied, String> {
    if base_rev != doc.rev {
        return Err(format!(
            "409: stale revision; current revision is {}",
            doc.rev
        ));
    }
    if ops.is_empty() || ops.len() > 256 {
        return Err("400: empty or oversized op batch".into());
    }
    if !["draft", "ready", "paused"].contains(&doc.status.as_str())
        || doc.nodes.iter().any(|n| live(&n.status))
    {
        return Err("pause and wait for active nodes before editing the graph".into());
    }
    let mut next = doc.clone();
    let mut inverses = Vec::new();
    let mut warnings = Vec::new();
    for op in ops {
        let mut undo = Vec::new();
        match op {
            RunOp::AddNode { node } => {
                if node.status != "pending"
                    || node.attempt != 0
                    || node.child_session_id.is_some()
                    || node.started_at.is_some()
                    || node.ended_at.is_some()
                    || node.meter.is_some()
                    || !node.attempt_meters.is_empty()
                    || node.exit_code.is_some()
                    || !node.output.is_empty()
                    || !node.queued_messages.is_empty()
                {
                    return Err("new nodes must be pending with no execution state".into());
                }
                next.nodes.push(node.clone());
                undo.push(RunOp::RemoveNode {
                    id: node.id.clone(),
                });
            }
            RunOp::UpdateNode { id, set } => {
                let node = next
                    .nodes
                    .iter_mut()
                    .find(|n| &n.id == id)
                    .ok_or("unknown node")?;
                if node.status == "passed" {
                    return Err("retry a completed node before changing its specification".into());
                }
                let (value, old) =
                    patch(serde_json::to_value(&*node).unwrap(), set, NODE_PATCH_KEYS)?;
                *node = serde_json::from_value(value).map_err(|e| e.to_string())?;
                undo.push(RunOp::UpdateNode {
                    id: id.clone(),
                    set: old,
                });
            }
            RunOp::RemoveNode { id } => {
                let i = next
                    .nodes
                    .iter()
                    .position(|n| &n.id == id)
                    .ok_or("unknown node")?;
                if next.nodes[i].attempt > 0 {
                    return Err("skip an executed node to preserve its measured record".into());
                }
                undo.push(RunOp::AddNode {
                    node: next.nodes.remove(i),
                });
                let removed: Vec<_> = next
                    .edges
                    .iter()
                    .filter(|e| &e.from == id || &e.to == id)
                    .cloned()
                    .collect();
                next.edges.retain(|e| &e.from != id && &e.to != id);
                undo.extend(removed.into_iter().map(|edge| RunOp::AddEdge { edge }));
            }
            RunOp::AddEdge { edge } => {
                next.edges.push(edge.clone());
                undo.push(RunOp::RemoveEdge {
                    id: edge.id.clone(),
                });
            }
            RunOp::UpdateEdge { id, set } => {
                let e = next
                    .edges
                    .iter_mut()
                    .find(|e| &e.id == id)
                    .ok_or("unknown edge")?;
                let (v, old) = patch(serde_json::to_value(&*e).unwrap(), set, &["type"])?;
                *e = serde_json::from_value(v).map_err(|e| e.to_string())?;
                undo.push(RunOp::UpdateEdge {
                    id: id.clone(),
                    set: old,
                });
            }
            RunOp::RemoveEdge { id } => {
                let i = next
                    .edges
                    .iter()
                    .position(|e| &e.id == id)
                    .ok_or("unknown edge")?;
                undo.push(RunOp::AddEdge {
                    edge: next.edges.remove(i),
                });
            }
            RunOp::MoveNode { id, before_id } => {
                let i = next
                    .nodes
                    .iter()
                    .position(|n| &n.id == id)
                    .ok_or("unknown node")?;
                if before_id.as_ref() == Some(id) {
                    return Err("cannot move a node before itself".into());
                }
                let old_before = next.nodes.get(i + 1).map(|n| n.id.clone());
                let node = next.nodes.remove(i);
                let target = match before_id {
                    Some(before) => next
                        .nodes
                        .iter()
                        .position(|n| &n.id == before)
                        .ok_or("unknown beforeId")?,
                    None => next.nodes.len(),
                };
                next.nodes.insert(target, node);
                undo.push(RunOp::MoveNode {
                    id: id.clone(),
                    before_id: old_before,
                });
            }
            RunOp::SetParallelism { value } => {
                undo.push(RunOp::SetParallelism {
                    value: next.max_write_parallel,
                });
                next.max_write_parallel = *value;
            }
        }
        validate(&next)?;
        undo.extend(inverses);
        inverses = undo;
    }
    for node in &next.nodes {
        if let Some(id) = &node.plan_block_id {
            if !id.trim_start_matches("rl:").starts_with("blk-") {
                warnings.push(format!("{} has an unrecognized plan block anchor", node.id));
            }
        }
    }
    next.rev += 1;
    Ok(Applied {
        doc: next,
        inverses,
        warnings,
    })
}

/// Glob matching only concerns hints. Physical, normalized claims are authority.
pub fn scope_matches(pattern: &str, path: &str) -> bool {
    // Dynamic programming avoids exponential backtracking on a model-emitted
    // glob such as **a**a**a and bounds memory to one row per path.
    let p = pattern.as_bytes();
    let text = path.as_bytes();
    let mut row = vec![false; text.len() + 1];
    row[0] = true;
    let mut i = 0;
    while i < p.len() {
        let mut next = vec![false; text.len() + 1];
        if p[i] == b'*' {
            let recursive = p.get(i + 1) == Some(&b'*');
            if recursive {
                i += 1;
            }
            next[0] = row[0];
            for j in 1..=text.len() {
                next[j] = row[j] || (next[j - 1] && (recursive || text[j - 1] != b'/'));
            }
            if recursive && p.get(i + 1) == Some(&b'/') {
                // **/ may consume zero complete directories. Positive matches
                // consume only prefixes ending in slash.
                let mut directories = row.clone();
                for j in 1..=text.len() {
                    if text[j - 1] == b'/' && next[j] {
                        directories[j] = true;
                    }
                }
                next = directories;
                i += 1;
            }
        } else {
            for j in 1..=text.len() {
                next[j] =
                    row[j - 1] && (p[i] == text[j - 1] || (p[i] == b'?' && text[j - 1] != b'/'));
            }
        }
        row = next;
        i += 1;
    }
    row[text.len()]
}

pub fn hints_overlap(a: &RunNode, b: &RunNode) -> bool {
    a.scope_hint.iter().any(|x| {
        b.scope_hint.iter().any(|y| {
            let xp = x.split(['*', '?']).next().unwrap_or("");
            let yp = y.split(['*', '?']).next().unwrap_or("");
            xp.starts_with(yp) || yp.starts_with(xp)
        })
    })
}
pub fn task_predecessors(doc: &RunGraph, node: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut todo = vec![node.to_string()];
    let mut tasks = Vec::new();
    while let Some(id) = todo.pop() {
        for e in doc
            .edges
            .iter()
            .filter(|e| e.edge_type == "blocks" && e.to == id)
        {
            if seen.insert(e.from.clone()) {
                if doc.nodes.iter().any(|n| n.id == e.from && n.kind == "task") {
                    tasks.push(e.from.clone());
                }
                todo.push(e.from.clone());
            }
        }
    }
    tasks.sort();
    tasks
}
pub fn check_coverage(doc: &RunGraph, check: &RunNode, claims: &[RunClaim]) -> HashSet<String> {
    let predecessors = task_predecessors(doc, &check.id);
    claims
        .iter()
        .filter(|c| predecessors.contains(&c.node_id))
        .map(|c| c.path.clone())
        .collect()
}
pub fn ready_nodes(doc: &RunGraph, claims: &[RunClaim]) -> Vec<String> {
    let mut selected: Vec<&RunNode> = Vec::new();
    let live_nodes: Vec<_> = doc.nodes.iter().filter(|n| live(&n.status)).collect();
    let running_tasks = live_nodes.iter().filter(|n| n.kind == "task").count();
    for n in doc.nodes.iter().filter(|n| n.status == "pending") {
        if doc
            .edges
            .iter()
            .filter(|e| e.edge_type == "blocks" && e.to == n.id)
            .any(|e| {
                !doc.nodes
                    .iter()
                    .any(|p| p.id == e.from && satisfied(&p.status))
            })
        {
            continue;
        }
        if n.kind == "task" {
            if running_tasks + selected.iter().filter(|s| s.kind == "task").count()
                >= doc.max_write_parallel as usize
            {
                continue;
            }
            if live_nodes
                .iter()
                .chain(selected.iter())
                .any(|s| s.kind == "task" && hints_overlap(n, s))
            {
                continue;
            }
            if live_nodes
                .iter()
                .chain(selected.iter())
                .any(|s| s.kind == "review" || (s.kind == "check" && s.check_global))
            {
                continue;
            }
        }
        if matches!(n.kind.as_str(), "check" | "review") {
            let coverage = check_coverage(doc, n, claims);
            if live_nodes.iter().chain(selected.iter()).any(|s| {
                s.kind == "task"
                    && (n.kind == "review"
                        || n.check_global
                        || claims
                            .iter()
                            .any(|c| c.node_id == s.id && coverage.contains(&c.path)))
            }) {
                continue;
            }
            // Conservative prior: a scoped check and a freshly scheduled task
            // may run together; the synchronous claim veto enforces the barrier.
        }
        selected.push(n);
        if n.kind == "gate" {
            break;
        }
    }
    selected.into_iter().map(|n| n.id.clone()).collect()
}
#[derive(Debug, PartialEq)]
pub enum FailureAttribution {
    Retry(String),
    Human(Vec<String>),
}
pub fn attribute_failure(doc: &RunGraph, check: &str) -> FailureAttribution {
    let candidates = task_predecessors(doc, check);
    if candidates.len() == 1 {
        let n = doc.nodes.iter().find(|n| n.id == candidates[0]).unwrap();
        if n.attempt < n.max_attempts {
            return FailureAttribution::Retry(n.id.clone());
        }
    }
    FailureAttribution::Human(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn graph() -> RunGraph {
        serde_json::from_str(include_str!("../../src/lib/runner/fixtures/basic.json")).unwrap()
    }
    #[test]
    fn shared_fixture_is_valid_and_parallel() {
        let g = graph();
        validate(&g).unwrap();
        assert_eq!(ready_nodes(&g, &[]), vec!["n-api", "n-ui"]);
    }
    #[test]
    fn reducer_is_atomic_and_rejects_stale_identity_and_cycles() {
        let g = graph();
        let mut patch = Map::new();
        patch.insert("id".into(), Value::String("other".into()));
        assert!(apply(
            &g,
            0,
            &[RunOp::UpdateNode {
                id: "n-api".into(),
                set: patch
            }]
        )
        .is_err());
        assert!(apply(&g, 3, &[RunOp::SetParallelism { value: 1 }])
            .unwrap_err()
            .starts_with("409"));
        assert!(apply(
            &g,
            0,
            &[RunOp::AddEdge {
                edge: RunEdge {
                    id: "e-cycle".into(),
                    from: "n-check".into(),
                    to: "n-api".into(),
                    edge_type: "blocks".into()
                }
            }]
        )
        .is_err());
        assert_eq!(g.rev, 0);
    }
    #[test]
    fn shared_edit_fixture_and_undo() {
        let g = graph();
        let ops: Vec<RunOp> =
            serde_json::from_str(include_str!("../../src/lib/runner/fixtures/edit_ops.json"))
                .unwrap();
        let a = apply(&g, 0, &ops).unwrap();
        assert_eq!(a.doc.nodes[0].title, "Implement typed API");
        assert_eq!(a.doc.max_write_parallel, 2);
        assert_eq!(a.doc.nodes.last().unwrap().id, "n-release");
        let back = apply(&a.doc, 1, &a.inverses).unwrap();
        assert_eq!(back.doc.nodes, g.nodes);
        assert_eq!(back.doc.edges, g.edges);
    }
    #[test]
    fn inverse_restores_specification() {
        let g = graph();
        let a = apply(&g, 0, &[RunOp::SetParallelism { value: 1 }]).unwrap();
        let b = apply(&a.doc, 1, &a.inverses).unwrap();
        assert_eq!(b.doc.max_write_parallel, g.max_write_parallel);
    }
    #[test]
    fn failed_predecessor_cannot_unlock_downstream() {
        let mut g = graph();
        g.nodes[0].status = "failed".into();
        g.nodes[1].status = "passed".into();
        assert!(ready_nodes(&g, &[]).is_empty());
    }
    #[test]
    fn global_check_waits_for_unrelated_task() {
        let mut g = graph();
        g.nodes[0].status = "passed".into();
        g.nodes[1].status = "passed".into();
        let mut extra = g.nodes[0].clone();
        extra.id = "n-other".into();
        extra.status = "running".into();
        g.nodes.push(extra);
        assert!(ready_nodes(&g, &[]).is_empty());
    }
    #[test]
    fn review_is_a_global_barrier_even_when_marked_scoped() {
        let mut g = graph();
        g.edges.retain(|e| e.from != "n-ui");
        g.nodes[0].status = "passed".into();
        g.nodes[1].status = "running".into();
        g.nodes[2].kind = "review".into();
        g.nodes[2].check_global = false;
        assert!(ready_nodes(&g, &[]).is_empty());
        g.nodes[1].status = "pending".into();
        // Selection itself also reserves the barrier in either list order.
        assert_eq!(ready_nodes(&g, &[]), vec!["n-ui"]);
        g.nodes.swap(1, 2);
        assert_eq!(ready_nodes(&g, &[]), vec!["n-check"]);
        g.nodes[1].status = "running".into();
        assert!(ready_nodes(&g, &[]).is_empty());
    }
    #[test]
    fn ambiguous_failures_never_retry() {
        let g = graph();
        assert_eq!(
            attribute_failure(&g, "n-check"),
            FailureAttribution::Human(vec!["n-api".into(), "n-ui".into()])
        );
    }
    #[test]
    fn single_failure_has_bounded_retry() {
        let mut g = graph();
        g.edges.retain(|e| e.from != "n-ui");
        assert_eq!(
            attribute_failure(&g, "n-check"),
            FailureAttribution::Retry("n-api".into())
        );
        g.nodes[0].attempt = 2;
        assert!(matches!(
            attribute_failure(&g, "n-check"),
            FailureAttribution::Human(_)
        ));
    }
    #[test]
    fn hint_globs() {
        assert!(scope_matches("src/**/*.rs", "src/lib.rs"));
        assert!(scope_matches("src/**/*.rs", "src/nested/lib.rs"));
        assert!(!scope_matches("src/*.rs", "src/nested/lib.rs"));
    }
}
