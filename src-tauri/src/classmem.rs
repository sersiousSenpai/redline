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

use std::collections::HashMap;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::claude_proc::{classify_line, claude_command, resolve_claude_bin, StreamLine};
use crate::db::Database;
use crate::ledger::{self, now_millis, DecisionInput, EventKind};

/// A general (repo-less) root always seeded alongside the repo roots.
pub const GENERAL_ROOT_ID: &str = "root-general";

/// Cap on how much delta the classifier is fed / how many links a node returns —
/// keeps the spawn prompt and route responses bounded on a long history.
pub const MAX_DELTA_ITEMS: usize = 400;
/// Byte bound on the classifier's baked-in corpus, mirroring code.rs's 60KB.
const MAX_CORPUS_BYTES: usize = 60_000;

// ---------------------------------------------------------------------------
// Row types (mirrors of the class_* tables)
// ---------------------------------------------------------------------------

/// A class node. A *class* is just a root (`parent_id == None`); depth is
/// emergent (no level enum). A `digest` node's `summary` is the agent-written
/// gist of a collapsed cold branch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String, // "node" | "digest"
    pub title: String,
    pub summary: Option<String>,
    pub project_path: Option<String>,
    pub ip_name: Option<String>,
    pub status: String, // "proposed" | "accepted"
    pub pinned: bool,
    pub curated_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A pointer from a class node into the lake.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassLink {
    pub id: i64,
    pub node_id: String,
    pub target_kind: String, // prompt|session|revision|mission|decision
    pub target_id: String,
    pub note: Option<String>,
    pub status: String,
    pub created_at: i64,
}

/// A queued structural reorg proposal (promote/split/merge/collapse).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassProposalRow {
    pub id: i64,
    pub run_id: Option<i64>,
    pub op: String,
    pub node_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub extra_json: Option<String>,
    pub rationale: Option<String>,
    pub status: String,
    pub created_at: i64,
}

/// One classifier pass over the lake delta.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassRun {
    pub id: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String, // running | done | error
    pub seq_from: Option<i64>,
    pub seq_to: Option<i64>,
    pub claude_session_id: Option<String>,
    pub summary: Option<String>,
}

/// A compact prompt/decision item fed to the classifier and returned by
/// `GET /v1/memory/prompts`. Provenance (`project_path`/`surface`/dates) is
/// carried as ground truth — the classifier never infers where a memory came
/// from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LakeItem {
    pub seq: i64,
    pub ts: i64,
    pub kind: String,   // prompt | resolution | approval | pin | ...
    pub surface: Option<String>,
    pub origin: Option<String>,
    pub role: Option<String>,
    pub session_id: Option<String>,
    pub mission_id: Option<String>,
    pub project_path: Option<String>,
    pub ref_kind: Option<String>,
    pub ref_id: Option<String>,
    /// The prompt body (truncated) for prompt items; `None` for decision events
    /// (they reference a row, not a stored body).
    pub body: Option<String>,
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/// Deterministic root id for a repo path, so re-seeding is idempotent (the same
/// repo never seeds twice).
pub fn root_id_for_path(path: &str) -> String {
    format!("root-{}", &ledger::sha256_hex(path.as_bytes())[..12])
}

/// The roots to seed: one per known repo (title = basename) + the `~general`
/// root. Pure so it's unit-tested against a fixed registry.
pub fn seed_root_rows(project_paths: &[String]) -> Vec<(String, String, Option<String>)> {
    let mut rows: Vec<(String, String, Option<String>)> = Vec::new();
    for path in project_paths {
        let title = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| path.clone());
        rows.push((root_id_for_path(path), title, Some(path.clone())));
    }
    rows.push((GENERAL_ROOT_ID.to_string(), "~general".to_string(), None));
    rows
}

// ---------------------------------------------------------------------------
// Proposal parsing (the classifier's structured-JSON output)
// ---------------------------------------------------------------------------

/// One part of a `split` op: a new sub-class title and the link ids that move to
/// it.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SplitPart {
    pub title: String,
    #[serde(default)]
    pub link_ids: Vec<i64>,
}

/// A parsed proposal. `file`/`create` are additive (staged as proposed rows);
/// `promote`/`split`/`merge`/`collapse` are structural (queued for review).
#[derive(Debug, Clone, PartialEq)]
pub enum Proposal {
    File {
        parent_id: String,
        sub_class: Option<String>,
        target_kind: String,
        target_id: String,
        note: Option<String>,
        rationale: Option<String>,
    },
    Create {
        parent_id: String,
        title: String,
        rationale: Option<String>,
    },
    Promote {
        node_id: String,
        new_parent_id: Option<String>,
        rationale: Option<String>,
    },
    Split {
        node_id: String,
        into: Vec<SplitPart>,
        rationale: Option<String>,
    },
    Merge {
        node_ids: Vec<String>,
        title: Option<String>,
        parent_id: Option<String>,
        rationale: Option<String>,
    },
    Collapse {
        node_id: String,
        summary: String,
        cite_seqs: Vec<i64>,
        rationale: Option<String>,
    },
}

/// Extract the proposals JSON from a classifier's final message. Tolerates the
/// model wrapping it in a ```json fence or in surrounding prose: finds the first
/// balanced `{...}` object that parses and contains a `proposals` array. Pure.
pub fn parse_proposals(text: &str) -> Vec<Proposal> {
    let Some(obj) = extract_json_object(text) else {
        return Vec::new();
    };
    let Some(arr) = obj.get("proposals").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter().filter_map(parse_one).collect()
}

/// Find the first top-level `{...}` substring that parses as JSON. Scans for a
/// `{`, then walks to the matching brace respecting string literals/escapes, and
/// tries to parse each candidate. Bounded by the input length.
fn extract_json_object(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = matching_brace(bytes, i) {
                if let Ok(v) = serde_json::from_str::<Value>(&text[i..=end]) {
                    if v.get("proposals").is_some() {
                        return Some(v);
                    }
                }
            }
        }
        i += 1;
    }
    None
}

fn matching_brace(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (offset, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(offset);
                }
            }
            _ => {}
        }
    }
    None
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn parse_one(v: &Value) -> Option<Proposal> {
    let op = str_field(v, "op")?;
    let rationale = str_field(v, "rationale").map(str::to_string);
    match op {
        "file" => {
            // A lake target id may be a number (prompt/ledger seq) or a string
            // (session/mission id) — accept both.
            let target_id = value_as_id(v.get("target_id"))?;
            Some(Proposal::File {
                parent_id: str_field(v, "parent_id")?.to_string(),
                sub_class: str_field(v, "sub_class").map(str::to_string),
                target_kind: str_field(v, "target_kind")?.to_string(),
                target_id,
                note: str_field(v, "note").map(str::to_string),
                rationale,
            })
        }
        "create" => Some(Proposal::Create {
            parent_id: str_field(v, "parent_id")?.to_string(),
            title: str_field(v, "title")?.to_string(),
            rationale,
        }),
        "promote" => Some(Proposal::Promote {
            node_id: str_field(v, "node_id")?.to_string(),
            new_parent_id: str_field(v, "new_parent_id").map(str::to_string),
            rationale,
        }),
        "split" => {
            let into: Vec<SplitPart> = v
                .get("into")
                .and_then(|x| serde_json::from_value(x.clone()).ok())
                .unwrap_or_default();
            if into.is_empty() {
                return None;
            }
            Some(Proposal::Split {
                node_id: str_field(v, "node_id")?.to_string(),
                into,
                rationale,
            })
        }
        "merge" => {
            let node_ids: Vec<String> = v
                .get("node_ids")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if node_ids.len() < 2 {
                return None;
            }
            Some(Proposal::Merge {
                node_ids,
                title: str_field(v, "title").map(str::to_string),
                parent_id: str_field(v, "parent_id").map(str::to_string),
                rationale,
            })
        }
        "collapse" => {
            let cite_seqs: Vec<i64> = v
                .get("cite_seqs")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default();
            Some(Proposal::Collapse {
                node_id: str_field(v, "node_id")?.to_string(),
                summary: str_field(v, "summary")?.to_string(),
                cite_seqs,
                rationale,
            })
        }
        _ => None, // unknown op — skipped (logged by the caller if it wants)
    }
}

/// A lake target id may arrive as a JSON number or string.
fn value_as_id(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Staging (materialize parsed proposals as reviewable rows)
// ---------------------------------------------------------------------------

/// Fresh node id for a created/staged node.
pub fn new_node_id() -> String {
    format!("cn-{}", uuid::Uuid::new_v4().simple())
}

/// Outcome counts from staging a batch of proposals.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageResult {
    pub created_nodes: usize,
    pub staged_links: usize,
    pub structural: usize,
    pub skipped: usize,
}

/// Stage a batch of parsed proposals into reviewable rows. Additive proposals
/// become `proposed` nodes/links; structural proposals queue in
/// `class_proposals`. Never accepts anything. Returns per-op counts.
pub fn stage_proposals(
    db: &Database,
    run_id: Option<i64>,
    proposals: &[Proposal],
) -> Result<StageResult, String> {
    let mut r = StageResult::default();
    for p in proposals {
        let staged = db.stage_proposal(run_id, p).map_err(|e| e.to_string())?;
        match staged {
            StagedOutcome::Link { created_node } => {
                r.staged_links += 1;
                if created_node {
                    r.created_nodes += 1;
                }
            }
            StagedOutcome::Node => r.created_nodes += 1,
            StagedOutcome::Structural => r.structural += 1,
            StagedOutcome::Skipped => r.skipped += 1,
        }
    }
    Ok(r)
}

/// What `Database::stage_proposal` did with one proposal.
pub enum StagedOutcome {
    Node,
    Link { created_node: bool },
    Structural,
    Skipped,
}

/// The result of applying (accepting) a structural proposal — the facts the
/// caller needs to write the `taxonomy_reorg` ledger event.
pub struct AppliedReorg {
    pub op: String,
    pub node_id: String,
    pub detail: String,
}

// ---------------------------------------------------------------------------
// Classifier spawn + drive
// ---------------------------------------------------------------------------

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

/// Human "N days" between two ms timestamps (for the classifier prompt).
fn days_between(newer: i64, older: i64) -> i64 {
    ((newer - older).max(0)) / 86_400_000
}

/// Build the classifier's first-turn prompt: the accepted tree (with each
/// branch's temporal + storage facts) + the lake delta, with the ops contract.
/// Pure / testable. Provenance — including *temporal* provenance — is presented
/// as fact; the classifier never infers it. Corpus is byte-bounded.
pub fn build_classifier_prompt(
    tree: &[ClassNode],
    delta: &[LakeItem],
    stats: &HashMap<String, BranchStat>,
    env: LakeEnvelope,
) -> String {
    let mut p = String::new();
    p.push_str(
        "You are Redline's ClassMemory orchestrator. You organize the user's raw \
         prompt/decision \"lake\" into an emergent class tree. You are READ-ONLY \
         over the lake, and your organization is applied directly — the human \
         curates after, and every reorg is recorded in the ledger (auditable + \
         reversible), so organize with judgment and be conservative with the \
         destructive `collapse` op. Load your `classmemory` skill for the full \
         contract.\n\n",
    );
    // Temporal envelope — coldness is judged against the lake's OWN activity
    // (its newest event is "now"), never wall-clock, and as a fraction of this
    // span, so it self-calibrates to how much the user works.
    let span_days = days_between(env.newest, env.oldest);
    if env.span() > 0 {
        p.push_str(&format!(
            "## Lake activity envelope\n\nYour lake spans ~{span_days} day(s); its \
             newest event is \"now\". Judge coldness relative to THIS span (a \
             branch untouched across most of it is cold), never wall-clock. Each \
             branch below shows `items` (how much it holds) and `idle` (days since \
             its newest item — measured from now). A branch earns a `collapse` \
             only when it is BOTH clearly idle across most of the span AND large \
             enough that a digest compresses something; pinned branches never \
             collapse.\n\n",
        ));
    }
    p.push_str("## The accepted class tree (roots are classes; depth is emergent)\n\n");
    if tree.is_empty() {
        p.push_str("(empty — only the seeded roots below exist)\n");
    }
    for n in tree {
        let depth = tree_depth(tree, n);
        let indent = "  ".repeat(depth);
        let tag = if n.status == "proposed" { " [proposed]" } else { "" };
        let proj = n
            .project_path
            .as_deref()
            .map(|x| format!("  project={x}"))
            .unwrap_or_default();
        // Temporal + storage facts for coldness (ground truth, not inferred).
        let facts = stats
            .get(&n.id)
            .map(|s| {
                let idle = s
                    .last_ts
                    .map(|t| format!("{}d", days_between(env.newest, t)))
                    .unwrap_or_else(|| "n/a".to_string());
                let pin = if s.pinned { " 📌pinned" } else { "" };
                format!("  items={} idle={idle}{pin}", s.item_count)
            })
            .unwrap_or_default();
        p.push_str(&format!(
            "{indent}- {} (id={}, kind={}){tag}{proj}{facts}\n",
            n.title, n.id, n.kind
        ));
    }
    p.push_str(
        "\n## The lake delta to classify (provenance is GROUND TRUTH — never \
         infer project_path or surface; use what's given)\n\n",
    );
    let mut used = p.len();
    for it in delta {
        let line = format!(
            "- seq {} | {} | project={} | surface={} | {}\n",
            it.seq,
            it.kind,
            it.project_path.as_deref().unwrap_or("~none"),
            it.surface.as_deref().unwrap_or("-"),
            it.body
                .as_deref()
                .map(|b| truncate_1line(b, 240))
                .unwrap_or_else(|| format!(
                    "[decision references {} {}]",
                    it.ref_kind.as_deref().unwrap_or("row"),
                    it.ref_id.as_deref().unwrap_or("")
                ))
        );
        if used + line.len() > MAX_CORPUS_BYTES {
            p.push_str("- … (delta truncated)\n");
            break;
        }
        used += line.len();
        p.push_str(&line);
    }
    p.push_str(
        "\n## Output\n\nReturn ONLY a JSON object (optionally in a ```json fence) \
         of the form:\n\n\
         {\"proposals\": [\n  \
         {\"op\":\"file\",\"parent_id\":\"<root/node id>\",\"sub_class\":\"<optional new sub-class title>\",\"target_kind\":\"prompt|session|revision|mission|decision\",\"target_id\":\"<lake seq/id>\",\"note\":\"<short>\",\"rationale\":\"<why>\"},\n  \
         {\"op\":\"create\",\"parent_id\":\"<id>\",\"title\":\"<class>\",\"rationale\":\"<why: size×coherence×recency>\"},\n  \
         {\"op\":\"promote\",\"node_id\":\"<id>\",\"new_parent_id\":\"<id>\",\"rationale\":\"<grew, earns its own class>\"},\n  \
         {\"op\":\"split\",\"node_id\":\"<id>\",\"into\":[{\"title\":\"<a>\",\"link_ids\":[]},{\"title\":\"<b>\",\"link_ids\":[]}],\"rationale\":\"<why>\"},\n  \
         {\"op\":\"merge\",\"node_ids\":[\"<id>\",\"<id>\"],\"title\":\"<merged>\",\"rationale\":\"<why>\"},\n  \
         {\"op\":\"collapse\",\"node_id\":\"<id>\",\"summary\":\"<agent-written gist>\",\"cite_seqs\":[<exact ledger seqs>],\"rationale\":\"<cold, unpinned>\"}\n]}\n\n\
         Every proposal needs a rationale. Promotion is size × coherence × \
         recency — never a fixed count. Do not split a coherent subject on its \
         verbs. Collapse only cold, unpinned branches, and cite the exact ledger \
         seqs the digest summarizes.\n",
    );
    p
}

fn tree_depth(tree: &[ClassNode], node: &ClassNode) -> usize {
    let mut depth = 0;
    let mut cur = node.parent_id.clone();
    while let Some(pid) = cur {
        depth += 1;
        cur = tree.iter().find(|n| n.id == pid).and_then(|n| n.parent_id.clone());
        if depth > 12 {
            break; // cycle guard
        }
    }
    depth
}

fn truncate_1line(s: &str, max: usize) -> String {
    let one = s.replace('\n', " ");
    if one.chars().count() <= max {
        one
    } else {
        let cut: String = one.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// Run the classifier headless to completion and return its final text. The tool
/// surface matches the browse/mission agents (curl bridge to the localhost
/// daemon so it can read `/v1/memory/*`), with MCP stripped. The delta corpus is
/// baked into `prompt` so the core loop doesn't depend on the agent curling.
pub async fn run_classifier(cwd: &str, prompt: String) -> Result<(String, Option<String>), String> {
    let claude_bin = tokio::task::spawn_blocking(resolve_claude_bin)
        .await
        .map_err(|e| e.to_string())?;
    // The classifier is a Redline-internal agent; headless `-p` fires the global
    // UserPromptSubmit hook, so register its exact prompt with the dedup guard
    // BEFORE spawning — otherwise the hook would capture the classifier's own
    // (huge) prompt into the lake, and the next run would try to classify it.
    ledger::register_agent_prompt(&ledger::body_hash(&prompt));
    let args = crate::claude_proc::bridge_args(prompt, None);
    let mut cmd = claude_command(&claude_bin);
    let mut child = cmd
        .current_dir(cwd)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "could not find the `claude` CLI (looked for `{claude_bin}`). \
                     Install Claude Code, or launch Redline from a terminal."
                )
            } else {
                format!("failed to spawn the classifier: {e}")
            }
        })?;
    let stdout = child.stdout.take().ok_or("classifier stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("classifier stderr unavailable")?;

    let mut reader = BufReader::new(stdout).lines();
    let mut session: Option<String> = None;
    let mut final_text: Option<String> = None;
    let mut errored: Option<String> = None;
    while let Ok(Some(line)) = reader.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match classify_line(&v) {
            StreamLine::Init(sid) => session = Some(sid),
            StreamLine::Final { text, session_id } => {
                final_text = Some(text);
                if let Some(sid) = session_id {
                    session = Some(sid);
                }
            }
            StreamLine::Failed(msg) => errored = Some(msg),
            _ => {}
        }
    }
    // Drain stderr for diagnostics on failure.
    let mut errbuf = String::new();
    {
        let mut elines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = elines.next_line().await {
            if errbuf.len() < 2000 {
                errbuf.push_str(&l);
                errbuf.push('\n');
            }
        }
    }
    let _ = child.wait().await;
    if let Some(msg) = errored {
        return Err(msg);
    }
    match final_text {
        Some(t) => Ok((t, session)),
        None => Err(if errbuf.trim().is_empty() {
            "classifier produced no output".to_string()
        } else {
            format!("classifier failed: {}", errbuf.trim())
        }),
    }
}

// ---------------------------------------------------------------------------
// One organize pass (shared by the command + the background keeper)
// ---------------------------------------------------------------------------

/// The result of one `organize_once` pass — enough for the command to build its
/// pane JSON and for the keeper to log/skip.
#[derive(Debug, Clone, Default)]
pub struct OrganizeOutcome {
    pub staged: StageResult,
    pub summary: String,
    pub auto_applied: bool,
    pub seq_from: i64,
    pub seq_to: i64,
    /// False when the lake delta was empty and the classifier never ran.
    pub ran: bool,
}

/// Run one classifier pass end-to-end against the current lake delta: seed roots,
/// compute the delta since the last completed run, spawn the read-only
/// classifier, stage its structured-JSON proposals, and — when auto-apply is on
/// (the default) — accept the additive batch and apply every structural op
/// except a not-clearly-cold `collapse` (held for review by the
/// `auto_collapse_safe` interlock). Pure of any UI: callers emit their own
/// change events. This is the brain the background keeper drives autonomously
/// and the `classmem_organize` command wraps.
pub async fn organize_once(db: &Database) -> Result<OrganizeOutcome, String> {
    let roots = seed_root_rows(&db.list_project_paths().map_err(|e| e.to_string())?);
    db.seed_class_roots(&roots).map_err(|e| e.to_string())?;

    let seq_from = db.last_run_seq_to().map_err(|e| e.to_string())?;
    let seq_to = db.max_ledger_seq().map_err(|e| e.to_string())?;
    let delta = db
        .list_lake_items_since(seq_from, MAX_DELTA_ITEMS as i64)
        .map_err(|e| e.to_string())?;
    let tree = db.list_class_nodes().map_err(|e| e.to_string())?;
    let run_id = db.insert_class_run(seq_from, seq_to).map_err(|e| e.to_string())?;

    if delta.is_empty() {
        db.finish_class_run(run_id, "done", None, "no new lake items to classify")
            .map_err(|e| e.to_string())?;
        return Ok(OrganizeOutcome {
            summary: "Nothing new to classify yet — capture some prompts first.".to_string(),
            seq_from,
            seq_to,
            ran: false,
            ..Default::default()
        });
    }

    // Temporal + storage facts so the orchestrator judges coldness against the
    // lake's own activity (fed as ground truth, never inferred).
    let direct = db.node_direct_link_activity().map_err(|e| e.to_string())?;
    let envelope = db.lake_envelope().map_err(|e| e.to_string())?;
    let stats = subtree_stats(&tree, &direct);
    let prompt = build_classifier_prompt(&tree, &delta, &stats, envelope);
    let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    // Default: the orchestrator organizes directly (no required human approval);
    // the ledger's taxonomy-reorg time-travel is the safety net. A reviewer who
    // prefers the gate turns this off.
    let auto_apply = db
        .get_setting("redline.classmem.autoApply")
        .map(|v| v != "false")
        .unwrap_or(true);

    match run_classifier(&cwd, prompt).await {
        Ok((text, session)) => {
            let proposals = parse_proposals(&text);
            let staged =
                stage_proposals(db, Some(run_id), &proposals).map_err(|e| e.to_string())?;
            let mut applied_reorgs = 0usize;
            let mut held_collapses = 0usize;
            if auto_apply {
                let accepted = db.accept_all_pending().map_err(|e| e.to_string())?;
                for nid in &accepted {
                    record_curate(db, nid, "organize", "");
                }
                // Recompute activity AFTER staging for the collapse interlock.
                let direct2 = db.node_direct_link_activity().map_err(|e| e.to_string())?;
                let nodes_now = db.list_class_nodes().map_err(|e| e.to_string())?;
                let stats2 = subtree_stats(&nodes_now, &direct2);
                let env2 = db.lake_envelope().map_err(|e| e.to_string())?;
                for prop in db.list_class_proposals().map_err(|e| e.to_string())? {
                    if prop.op == "collapse" {
                        let safe = prop
                            .node_id
                            .as_deref()
                            .and_then(|nid| stats2.get(nid))
                            .map(|s| auto_collapse_safe(s, env2))
                            .unwrap_or(false);
                        if !safe {
                            held_collapses += 1;
                            continue; // leave pending → shows in the review strip
                        }
                    }
                    if let Some(a) = db.apply_class_proposal(prop.id).map_err(|e| e.to_string())? {
                        record_reorg(db, &a.op, &a.node_id, &a.detail);
                        applied_reorgs += 1;
                    }
                }
            }
            let summary = if auto_apply {
                format!(
                    "Organized: {} class(es), {} link(s), {} reorg(s){}{}",
                    staged.created_nodes,
                    staged.staged_links,
                    applied_reorgs,
                    if held_collapses > 0 {
                        format!(", {held_collapses} collapse(s) held for review")
                    } else {
                        String::new()
                    },
                    if staged.skipped > 0 {
                        format!(", {} skipped", staged.skipped)
                    } else {
                        String::new()
                    }
                )
            } else {
                format!(
                    "{} class(es), {} link(s), {} structural, {} skipped — review to apply",
                    staged.created_nodes, staged.staged_links, staged.structural, staged.skipped
                )
            };
            db.finish_class_run(run_id, "done", session.as_deref(), &summary)
                .map_err(|e| e.to_string())?;
            Ok(OrganizeOutcome {
                staged,
                summary,
                auto_applied: auto_apply,
                seq_from,
                seq_to,
                ran: true,
            })
        }
        Err(e) => {
            let _ = db.finish_class_run(run_id, "error", None, &e);
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Accept helpers (decision/reorg ledger events)
// ---------------------------------------------------------------------------

/// Record a `class_curate` decision event for an accepted/pinned/renamed node.
pub fn record_curate(db: &Database, node_id: &str, action: &str, detail: &str) {
    let ph = ledger::decision_payload_hash(&[("action", action), ("node", node_id), ("detail", detail)]);
    if let Err(e) = ledger::record_decision(
        db,
        DecisionInput {
            kind: EventKind::ClassCurate,
            author: None,
            session_id: None,
            ref_kind: "class_node",
            ref_id: node_id,
            payload_hash: ph,
        },
    ) {
        tracing::warn!(error = %e, node_id, action, "failed to record class-curate ledger event");
    }
}

/// Record a `taxonomy_reorg` ledger event for an accepted structural op.
pub fn record_reorg(db: &Database, op: &str, node_id: &str, detail: &str) {
    let ph = ledger::decision_payload_hash(&[("op", op), ("node", node_id), ("detail", detail)]);
    let ts = now_millis();
    if let Err(e) = db.append_ledger_event(&ledger::LedgerAppend {
        kind: EventKind::TaxonomyReorg.as_str(),
        author: &ledger::local_author(),
        ts,
        prompt_id: None,
        session_id: None,
        version_number: None,
        ref_kind: Some("class_node"),
        ref_id: Some(node_id),
        payload_hash: &ph,
    }) {
        tracing::warn!(error = %e, op, node_id, "failed to record taxonomy-reorg ledger event");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_rows_are_deterministic_and_add_general() {
        let paths = vec!["/x/redline".to_string(), "/x/muslimlegalconnect".to_string()];
        let a = seed_root_rows(&paths);
        let b = seed_root_rows(&paths);
        assert_eq!(a.len(), 3); // 2 repos + ~general
        assert_eq!(a[0].0, b[0].0, "root ids are deterministic per path");
        assert_eq!(a[0].1, "redline");
        assert_eq!(a[1].1, "muslimlegalconnect");
        assert_eq!(a[2].0, GENERAL_ROOT_ID);
        assert_eq!(a[2].2, None);
        assert!(a[0].2.as_deref() == Some("/x/redline"));
    }

    #[test]
    fn parse_all_ops_from_a_fenced_block() {
        let text = r#"Here are my proposals:
```json
{"proposals":[
  {"op":"create","parent_id":"root-redline","title":"Loop Engineering","rationale":"8 items"},
  {"op":"file","parent_id":"root-redline","sub_class":"Loop Engineering","target_kind":"prompt","target_id":42,"note":"spawn","rationale":"coheres"},
  {"op":"promote","node_id":"cn-1","new_parent_id":"root-redline","rationale":"grew"},
  {"op":"split","node_id":"cn-2","into":[{"title":"Clerk","link_ids":[1,2]},{"title":"Sessions","link_ids":[3]}],"rationale":"two subjects"},
  {"op":"merge","node_ids":["cn-3","cn-4"],"title":"Auth","rationale":"dupes"},
  {"op":"collapse","node_id":"cn-5","summary":"old investing research","cite_seqs":[10,11,12],"rationale":"cold"}
]}
```
That's it."#;
        let props = parse_proposals(text);
        assert_eq!(props.len(), 6);
        assert!(matches!(props[0], Proposal::Create { .. }));
        match &props[1] {
            Proposal::File { target_id, sub_class, .. } => {
                assert_eq!(target_id, "42"); // numeric id coerced to string
                assert_eq!(sub_class.as_deref(), Some("Loop Engineering"));
            }
            _ => panic!("expected file"),
        }
        match &props[3] {
            Proposal::Split { into, .. } => assert_eq!(into.len(), 2),
            _ => panic!("expected split"),
        }
        match &props[5] {
            Proposal::Collapse { cite_seqs, .. } => assert_eq!(cite_seqs, &vec![10, 11, 12]),
            _ => panic!("expected collapse"),
        }
    }

    #[test]
    fn parse_ignores_prose_and_bad_ops() {
        assert!(parse_proposals("no json here").is_empty());
        // merge with <2 ids and split with no parts are dropped.
        let text = r#"{"proposals":[
          {"op":"frobnicate","node_id":"x"},
          {"op":"merge","node_ids":["only-one"]},
          {"op":"split","node_id":"y","into":[]},
          {"op":"create","parent_id":"root","title":"Keep","rationale":"ok"}
        ]}"#;
        let props = parse_proposals(text);
        assert_eq!(props.len(), 1);
        assert!(matches!(props[0], Proposal::Create { .. }));
    }

    #[test]
    fn build_prompt_marks_provenance_as_ground_truth() {
        let tree = vec![ClassNode {
            id: "root-redline".into(),
            parent_id: None,
            kind: "node".into(),
            title: "redline".into(),
            summary: None,
            project_path: Some("/x/redline".into()),
            ip_name: None,
            status: "accepted".into(),
            pinned: false,
            curated_by: None,
            created_at: 0,
            updated_at: 0,
        }];
        let delta = vec![LakeItem {
            seq: 1,
            ts: 0,
            kind: "prompt".into(),
            surface: Some("plan".into()),
            origin: Some("redline".into()),
            role: None,
            session_id: None,
            mission_id: None,
            project_path: Some("/x/redline".into()),
            ref_kind: None,
            ref_id: None,
            body: Some("wire the loop executor".into()),
        }];
        let mut stats = HashMap::new();
        stats.insert(
            "root-redline".to_string(),
            BranchStat { last_ts: Some(500), item_count: 3, pinned: false },
        );
        let env = LakeEnvelope { oldest: 0, newest: 1000 };
        let p = build_classifier_prompt(&tree, &delta, &stats, env);
        assert!(p.contains("GROUND TRUTH"));
        assert!(p.contains("root-redline"));
        assert!(p.contains("wire the loop executor"));
        assert!(p.contains("\"proposals\""));
        // Temporal + storage facts + the envelope are fed as ground truth.
        assert!(p.contains("items=3"));
        assert!(p.contains("envelope"));
    }

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
