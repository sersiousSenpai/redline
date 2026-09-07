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

use serde_json::Value;

use crate::db::Database;
use crate::ledger::{self, now_millis, DecisionInput, EventKind};

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
pub use polis_core::types::{
    AppliedReorg, ClassLink, ClassNode, ClassObservation, ClassProposalRow, ClassRun, LakeItem,
    StageResult, StagedOutcome, SupersessionOutcome, DECISION_KINDS,
};

/// A general (repo-less) root always seeded alongside the repo roots.
pub const GENERAL_ROOT_ID: &str = "root-general";

/// The actor the auto-organize path authors its ledger events as — the
/// classifier's seat name (`seat::KNOWN_SEATS`), so agent curation is
/// separable from the human's in the chain.
pub const CLASSIFIER_ACTOR: &str = "classifier";

/// Cap on how much delta the classifier is fed / how many links a node returns —
/// keeps the spawn prompt and route responses bounded on a long history.
pub const MAX_DELTA_ITEMS: usize = 400;
/// Byte bound on the classifier's baked-in corpus, mirroring code.rs's 60KB.
const MAX_CORPUS_BYTES: usize = 60_000;

// ---------------------------------------------------------------------------
// Row types (mirrors of the class_* tables)
// ---------------------------------------------------------------------------

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
// Staging (materialize parsed proposals as reviewable rows)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Classifier spawn + drive
// ---------------------------------------------------------------------------

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
        // Memory-by-session lineage — printed as ground truth so the
        // classifier can file by session/thread ancestry, not just by project.
        let mut lineage = String::new();
        if let Some(s) = it.session_id.as_deref().filter(|s| !s.is_empty()) {
            lineage.push_str(&format!(" | session={s}"));
        }
        if let (Some(tk), Some(tid)) = (it.thread_kind.as_deref(), it.thread_id.as_deref()) {
            lineage.push_str(&format!(" | thread={tk}:{tid}"));
        }
        if let Some(par) = it.parent_session_id.as_deref().filter(|s| !s.is_empty()) {
            lineage.push_str(&format!(" | parent=session:{par}"));
        }
        let line = format!(
            "- seq {} | {} | project={} | surface={}{lineage} | {}\n",
            it.seq,
            it.kind,
            it.project_path.as_deref().unwrap_or("~none"),
            it.surface.as_deref().unwrap_or("-"),
            it.body
                .as_deref()
                .map(|b| head_tail_1line(b, CLASSIFIER_ITEM_HEAD, CLASSIFIER_ITEM_TAIL))
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
         {\"op\":\"file\",\"parent_id\":\"<root/node id>\",\"sub_class\":\"<optional new sub-class title>\",\"target_kind\":\"prompt|session|revision|mission|decision|browse_event|note\",\"target_id\":\"<lake seq/id>\",\"note\":\"<short>\",\"rationale\":\"<why>\"},\n  \
         {\"op\":\"create\",\"parent_id\":\"<id>\",\"title\":\"<class>\",\"rationale\":\"<why: size×coherence×recency>\"},\n  \
         {\"op\":\"promote\",\"node_id\":\"<id>\",\"new_parent_id\":\"<id>\",\"rationale\":\"<grew, earns its own class>\"},\n  \
         {\"op\":\"split\",\"node_id\":\"<id>\",\"into\":[{\"title\":\"<a>\",\"link_ids\":[]},{\"title\":\"<b>\",\"link_ids\":[]}],\"rationale\":\"<why>\"},\n  \
         {\"op\":\"merge\",\"node_ids\":[\"<id>\",\"<id>\"],\"title\":\"<merged>\",\"rationale\":\"<why>\"},\n  \
         {\"op\":\"collapse\",\"node_id\":\"<id>\",\"summary\":\"<agent-written gist>\",\"cite_seqs\":[<exact ledger seqs>],\"rationale\":\"<cold, unpinned>\"},\n  \
         {\"op\":\"supersede\",\"old_seq\":<decision seq>,\"new_seq\":<decision seq>,\"rationale\":\"<why the newer decision replaces the older>\"}\n]}\n\n\
         Every proposal needs a rationale. Promotion is size × coherence × \
         recency — never a fixed count. Do not split a coherent subject on its \
         verbs. Collapse only cold, unpinned branches, and cite the exact ledger \
         seqs the digest summarizes. Emit `supersede` only when a NEWER decision \
         event (resolution/approval/review_verdict) genuinely reverses or \
         replaces an OLDER one on the same subject — never for prompts or \
         discussion, and never based on an observation (observations are \
         derived, not ground truth). Supersession marks the old decision as \
         replaced; it never erases it. Lake items of kind `note` are the \
         user's OWN margin notes and standalone thoughts — the only \
         human-authored signal in the lake. Weight them strongly for filing \
         and promotion (what the user bothered to write down matters), and \
         file them with target_kind `note` — but a note is a CURATION signal, \
         never provenance: `project_path`/`surface` remain the only filing \
         authority.\n",
    );
    p
}

// ---------------------------------------------------------------------------
// Catalog snapshot (baked into a retrieval agent's first turn)
// ---------------------------------------------------------------------------

/// Byte bound on the baked catalog snapshot. Deliberately a fifth of the
/// classifier's corpus budget: the snapshot's job is to hand a retrieval agent
/// enough *node ids* to skip the tree-walk turn, not to be the answer. Anything
/// that doesn't fit is a node the agent can still reach by curling the node
/// route — which the header tells it to do.
pub const CATALOG_SNAPSHOT_MAX_BYTES: usize = 12_000;

/// Render the ACCEPTED catalog as a compact indented outline — the thing a
/// retrieval agent otherwise spends a whole model turn curling
/// `/v1/memory/tree` to learn.
///
/// `title [id] (N links)` per node; roots carry their `project_path` (the
/// binding that answers "which repo is this?"); a `digest` node carries a short
/// gist so a collapsed cold branch still says what it holds. Observations are
/// deliberately absent — the answer-pack serves those per node, and snapshot
/// bytes buy breadth of ids instead.
///
/// Truncation drops the DEEPEST levels first: losing leaf nodes costs the agent
/// one extra descent, while losing roots would hide whole classes. Pure, so the
/// budget and the drop order are unit-tested directly.
pub fn render_catalog_snapshot(
    nodes: &[(ClassNode, i64)],
    head_seq: i64,
    max_bytes: usize,
) -> String {
    let accepted: Vec<(ClassNode, i64)> = nodes
        .iter()
        .filter(|(n, _)| n.status == "accepted")
        .cloned()
        .collect();
    if accepted.is_empty() {
        return format!(
            "(the catalog is empty as of seq {head_seq} — nothing has been \
             organized yet; search the lake directly)\n"
        );
    }
    let tree: Vec<ClassNode> = accepted.iter().map(|(n, _)| n.clone()).collect();

    // One rendered block per node (a digest adds its gist line), in document
    // order, tagged with its depth. Everything below is bookkeeping over this.
    let blocks: Vec<(usize, String)> = accepted
        .iter()
        .map(|(n, links)| {
            let depth = tree_depth(&tree, n);
            let indent = "  ".repeat(depth);
            let proj = n
                .project_path
                .as_deref()
                .filter(|_| n.parent_id.is_none())
                .map(|p| format!(" project={p}"))
                .unwrap_or_default();
            let mut block = format!("{indent}- {} [{}] ({links} links){proj}\n", n.title, n.id);
            if n.kind == "digest" {
                if let Some(s) = n.summary.as_deref().filter(|s| !s.trim().is_empty()) {
                    block.push_str(&format!("{indent}  digest: {}\n", truncate_1line(s, 100)));
                }
            }
            (depth, block)
        })
        .collect();
    let max_depth = blocks.iter().map(|(d, _)| *d).max().unwrap_or(0);
    // Room for the "… not shown" footer, always reserved so adding it can't
    // push a snapshot over budget.
    const FOOTER: usize = 80;
    let budget = max_bytes.saturating_sub(FOOTER);

    // The deepest level cap that fits whole. Levels are dropped deepest-first:
    // a missing leaf costs the agent one descent, a missing root hides a class.
    let level_bytes = |cap: usize| -> usize {
        blocks
            .iter()
            .filter(|(d, _)| *d <= cap)
            .map(|(_, b)| b.len())
            .sum()
    };
    let mut cap = 0usize;
    while cap < max_depth && level_bytes(cap + 1) <= budget {
        cap += 1;
    }

    // Then spend whatever is left admitting nodes from the NEXT level in
    // document order, so a budget that clears a level by a few bytes doesn't
    // discard the entire level below it.
    let mut spent = level_bytes(cap);
    let mut admitted: Vec<bool> = blocks.iter().map(|(d, _)| *d <= cap).collect();
    if cap < max_depth {
        for (i, (d, b)) in blocks.iter().enumerate() {
            if *d == cap + 1 && spent + b.len() <= budget {
                admitted[i] = true;
                spent += b.len();
            }
        }
    }

    let mut out = String::new();
    let mut dropped = 0usize;
    for (i, (_, b)) in blocks.iter().enumerate() {
        if admitted[i] {
            // Roots alone can still overflow a very small budget.
            if out.len() + b.len() > budget && !out.is_empty() {
                dropped += 1;
                continue;
            }
            out.push_str(b);
        } else {
            dropped += 1;
        }
    }
    if dropped > 0 {
        out.push_str(&format!(
            "- … ({dropped} more node(s) not shown — descend with the node route)\n"
        ));
    }
    out
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

/// Per-lake-item window in the classifier's baked delta. Head+tail rather than a
/// head: a prompt opens with its ask and closes with its decision, and the head
/// window was keeping the first while discarding the second. Widened from 240 to
/// 500 total because Phase 1 freed the corpus budget it would have cost —
/// agent prefaces no longer enter the delta at all.
const CLASSIFIER_ITEM_HEAD: usize = 300;
const CLASSIFIER_ITEM_TAIL: usize = 200;

/// One-line window keeping both ends of a body. Collapses to a plain truncation
/// when the text is short enough that both windows would overlap.
fn head_tail_1line(s: &str, head: usize, tail: usize) -> String {
    let one: Vec<char> = s.replace('\n', " ").chars().collect();
    if one.len() <= head + tail {
        return one.into_iter().collect();
    }
    let h: String = one[..head].iter().collect();
    let t: String = one[one.len() - tail..].iter().collect();
    format!("{h} … {t}")
}

/// Run the classifier headless to completion and return its final text and
/// session id. Since Session A4 of the Polis extraction the spawn is the
/// memory agent's (`polis_host::agent()` — Redline's own `claude -p` with the
/// same bridge block, seat flags and hook guard); the pass books what the
/// turn spent through the usage sink on BOTH exits, as it always did.
pub async fn run_classifier(
    db: &Database,
    cwd: &str,
    prompt: String,
) -> Result<(String, Option<String>), String> {
    run_memory_agent(db, "classifier", cwd, prompt, Some("proposals"))
        .await
        .map(|reply| (reply.text, reply.session_id))
}

/// One memory-seat turn through the [`polis_llm::Agent`] seam, with the
/// turn's cost booked on every exit. Shared by the classifier, the supersede
/// verifier (both `classifier`) and the keeper's summarizer/observer.
pub async fn run_memory_agent(
    db: &Database,
    seat: &str,
    cwd: &str,
    prompt: String,
    response_key: Option<&'static str>,
) -> Result<polis_llm::AgentReply, String> {
    use polis_llm::UsageSink;
    let agent = crate::polis_host::agent();
    let mut req = polis_llm::AgentRequest::new(seat, prompt).cwd(cwd);
    req.response_key = response_key;
    let sink = crate::polis_host::RedlineUsage::new(db);
    match agent.run(req).await {
        Ok(reply) => {
            sink.book(seat, &reply.usage);
            Ok(reply)
        }
        Err(e) => {
            // Booked before the error return: a failed pass spent its input tokens.
            sink.book(seat, &e.usage);
            Err(e.message)
        }
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

    match run_classifier(db, &cwd, prompt).await {
        Ok((text, session)) => {
            let proposals = parse_proposals(&text);
            let staged =
                stage_proposals(db, Some(run_id), &proposals).map_err(|e| e.to_string())?;
            let mut applied_reorgs = 0usize;
            let mut held = 0usize;
            if auto_apply {
                let accepted = db
                    .accept_all_pending(CLASSIFIER_ACTOR)
                    .map_err(|e| e.to_string())?;
                for nid in &accepted {
                    record_curate(db, CLASSIFIER_ACTOR, nid, "organize", "");
                }
                // Recompute activity AFTER staging for the collapse interlock.
                let direct2 = db.node_direct_link_activity().map_err(|e| e.to_string())?;
                let nodes_now = db.list_class_nodes().map_err(|e| e.to_string())?;
                let stats2 = subtree_stats(&nodes_now, &direct2);
                let env2 = db.lake_envelope().map_err(|e| e.to_string())?;
                for prop in db.list_class_proposals().map_err(|e| e.to_string())? {
                    // Gardener gate (confidence × reversibility): the always-on
                    // gardener acts alone only on cheap, REVERSIBLE ops
                    // (file/create/promote/split). Destructive or ambiguous ops
                    // are held in the review strip for the human — a `merge`
                    // fuses distinct nodes into one, and a not-clearly-cold
                    // `collapse` destroys a branch into a digest.
                    if prop.op == "merge" {
                        held += 1;
                        continue;
                    }
                    if prop.op == "supersede" {
                        // Never blind-applied — adjudicated by the verifier
                        // agent after this loop (additive in storage, but it
                        // changes what "what did I decide" answers).
                        continue;
                    }
                    if prop.op == "collapse" {
                        let safe = prop
                            .node_id
                            .as_deref()
                            .and_then(|nid| stats2.get(nid))
                            .map(|s| auto_collapse_safe(s, env2))
                            .unwrap_or(false);
                        if !safe {
                            held += 1;
                            continue; // leave pending → shows in the review strip
                        }
                    }
                    if let Some(a) = db
                        .apply_class_proposal(prop.id, CLASSIFIER_ACTOR)
                        .map_err(|e| e.to_string())?
                    {
                        record_reorg(db, CLASSIFIER_ACTOR, &a.op, &a.node_id, &a.detail);
                        applied_reorgs += 1;
                    }
                }
            }
            // Supersede recommendations get a machine confidence gate: an
            // independent adversarial agent adjudicates each one. Applied
            // supersessions record their own `supersede` ledger event inside
            // the apply; refuted ones are dropped; if the verifier can't run,
            // the rows stay staged in the review strip as the fallback.
            let mut superseded = 0usize;
            if auto_apply {
                let (sup_applied, _sup_dropped) = verify_supersede_proposals(db, &cwd).await;
                superseded = sup_applied;
            }
            let summary = if auto_apply {
                format!(
                    "Organized: {} class(es), {} link(s), {} reorg(s){}{}{}",
                    staged.created_nodes,
                    staged.staged_links,
                    applied_reorgs,
                    if superseded > 0 {
                        format!(", {superseded} supersession(s)")
                    } else {
                        String::new()
                    },
                    if held > 0 {
                        format!(", {held} destructive op(s) held for review")
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
// Supersede verifier (the machine confidence gate)
// ---------------------------------------------------------------------------

/// The adversarial adjudication prompt: evidence for both decisions per
/// proposal, and an instruction to REFUTE unless the replacement is clear.
fn build_supersede_verifier_prompt(db: &Database, pending: &[ClassProposalRow]) -> String {
    let mut p = String::from(
        "You are Redline's supersession verifier. The memory classifier proposed \
         that a newer decision REPLACES an older one (\"supersession\"). Applying \
         one permanently changes how \"what did I decide\" is answered, so your \
         job is adversarial: try to REFUTE each proposal. Affirm only when the \
         two decisions are genuinely about the SAME subject and the newer one \
         clearly reverses or replaces the older one. Different subjects, mere \
         follow-ups, refinements that keep the old decision standing, or thin \
         evidence → refute. If uncertain, refute.\n\n## Proposals\n\n",
    );
    for prop in pending {
        let pair = prop
            .extra_json
            .as_deref()
            .and_then(|e| serde_json::from_str::<Value>(e).ok())
            .and_then(|v| Some((v.get("old_seq")?.as_i64()?, v.get("new_seq")?.as_i64()?)));
        let Some((old_seq, new_seq)) = pair else {
            continue;
        };
        let ctx = |seq: i64| {
            db.decision_event_context(seq)
                .ok()
                .flatten()
                .unwrap_or_else(|| format!("event #{seq} (unresolvable)"))
        };
        p.push_str(&format!(
            "### proposal {}\n- OLD (to be superseded): {}\n- NEW (the replacement): {}\n- classifier's rationale: {}\n\n",
            prop.id,
            ctx(old_seq),
            ctx(new_seq),
            prop.rationale.as_deref().unwrap_or("(none)"),
        ));
    }
    p.push_str(
        "## Output\n\nReturn ONLY a JSON object (optionally in a ```json fence) \
         of the form:\n\n{\"verdicts\": [\n  \
         {\"proposalId\": <id>, \"apply\": true|false, \"confidence\": 0.0-1.0, \"reason\": \"<one sentence>\"}\n]}\n\n\
         One verdict per proposal. `apply: true` means you could NOT refute it \
         and the supersession should be recorded.\n",
    );
    p
}

/// Adjudicate every pending `supersede` proposal with one verifier spawn.
/// Applied ops append their `supersede` ledger event inside
/// `apply_supersession_locked` — no `taxonomy_reorg` is recorded for them.
/// Returns `(applied, dropped)`. Best-effort: on spawn/parse failure the
/// proposals stay staged (the review strip is the graceful fallback).
pub async fn verify_supersede_proposals(db: &Database, cwd: &str) -> (usize, usize) {
    let pending: Vec<ClassProposalRow> = match db.list_class_proposals() {
        Ok(rows) => rows.into_iter().filter(|p| p.op == "supersede").collect(),
        Err(e) => {
            tracing::warn!(error = %e, "could not list supersede proposals");
            return (0, 0);
        }
    };
    if pending.is_empty() {
        return (0, 0);
    }
    let prompt = build_supersede_verifier_prompt(db, &pending);
    let text = match run_classifier(db, cwd, prompt).await {
        Ok((text, _session)) => text,
        Err(e) => {
            tracing::info!(error = %e,
                "supersede verifier unavailable — proposals stay staged for review");
            return (0, 0);
        }
    };
    let verdicts = parse_supersede_verdicts(&text);
    let mut applied = 0usize;
    let mut dropped = 0usize;
    for prop in &pending {
        let Some(v) = verdicts.iter().find(|v| v.proposal_id == prop.id) else {
            continue; // no verdict → stays staged
        };
        if v.apply && v.confidence >= SUPERSEDE_CONFIDENCE_MIN {
            match db.apply_class_proposal(prop.id, CLASSIFIER_ACTOR) {
                Ok(Some(a)) => {
                    tracing::info!(target: "redline::classmem", detail = %a.detail,
                        confidence = v.confidence, "supersession applied");
                    applied += 1;
                }
                // Guardrail-rejected at apply (row already dropped inside).
                Ok(None) => dropped += 1,
                Err(e) => {
                    tracing::warn!(error = %e, proposal = prop.id, "supersession apply failed");
                }
            }
        } else {
            // Refuted / low confidence: drop, same semantics as a human
            // reject (which records no ledger event either).
            tracing::info!(target: "redline::classmem", proposal = prop.id,
                confidence = v.confidence, reason = %v.reason, "supersession refuted");
            let _ = db.reject_class_proposal(prop.id);
            dropped += 1;
        }
    }
    (applied, dropped)
}

// ---------------------------------------------------------------------------
// Accept helpers (decision/reorg ledger events)
// ---------------------------------------------------------------------------

/// Record a `class_curate` decision event for an accepted/pinned/renamed node.
/// `actor` is who curated: the classifier's seat name on the auto-organize
/// path, the local human on a GUI accept/pin/rename.
pub fn record_curate(db: &Database, actor: &str, node_id: &str, action: &str, detail: &str) {
    let ph = ledger::decision_payload_hash(&[("action", action), ("node", node_id), ("detail", detail)]);
    if let Err(e) = ledger::record_decision(
        db,
        DecisionInput {
            kind: EventKind::ClassCurate,
            author: Some(actor.to_string()),
            session_id: None,
            ref_kind: "class_node",
            ref_id: node_id,
            payload_hash: ph,
        },
    ) {
        tracing::warn!(error = %e, node_id, action, "failed to record class-curate ledger event");
    }
}

/// Revert an accepted `file` (the gardener's — or a user's — most common
/// action): remove the class link and append a **compensating** `class_curate`
/// event (`action="revert"`). This is the rollback primitive that lets the
/// Librarian act by default while the human stays supervisor: a bad auto-file is
/// undone without ever deleting a ledger event, so `verify_ledger_chain` /
/// `verify_bundle` stay green — the reversal is *recorded*, not erased. Returns
/// `true` if a link was removed, `false` if the link id didn't exist.
pub fn revert_link(db: &Database, actor: &str, link_id: i64) -> Result<bool, String> {
    match db.delete_class_link(link_id).map_err(|e| e.to_string())? {
        Some((node_id, target_kind, target_id)) => {
            let detail = format!("{target_kind}:{target_id}");
            record_curate(db, actor, &node_id, "revert", &detail);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Record a `taxonomy_reorg` ledger event for an accepted structural op.
/// `actor` is who applied it — classifier seat name or the local human.
pub fn record_reorg(db: &Database, actor: &str, op: &str, node_id: &str, detail: &str) {
    let ph = ledger::decision_payload_hash(&[("op", op), ("node", node_id), ("detail", detail)]);
    let ts = now_millis();
    if let Err(e) = db.append_ledger_event(&ledger::LedgerAppend {
        kind: EventKind::TaxonomyReorg.as_str(),
        author: actor,
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
            thread_kind: Some("browse".into()),
            thread_id: Some("tab-7".into()),
            parent_session_id: Some("sess-42".into()),
            model: None,
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
        // Memory-by-session lineage rides the delta line as ground truth too.
        assert!(p.contains("thread=browse:tab-7"));
        assert!(p.contains("parent=session:sess-42"));
    }

    /// The snapshot exists to save a model turn, so its shape is a contract:
    /// accepted nodes only, ids present (they're what the answer-pack's
    /// `&node=` takes), roots carrying their project binding, digests carrying
    /// their gist.
    #[test]
    fn catalog_snapshot_renders_ids_counts_and_root_bindings() {
        let n = |id: &str, parent: Option<&str>, title: &str, status: &str| ClassNode {
            id: id.into(),
            parent_id: parent.map(str::to_string),
            kind: "node".into(),
            title: title.into(),
            summary: None,
            project_path: parent.is_none().then(|| "/x/redline".to_string()),
            ip_name: None,
            status: status.into(),
            pinned: false,
            curated_by: None,
            created_at: 0,
            updated_at: 0,
        };
        let mut digest = n("d1", Some("root"), "Cold Branch", "accepted");
        digest.kind = "digest".into();
        digest.summary = Some("the old loop work, collapsed".into());
        let nodes = vec![
            (n("root", None, "redline", "accepted"), 40i64),
            (n("kid", Some("root"), "Loop Engineering", "accepted"), 12),
            (digest, 5),
            (n("ghost", Some("root"), "Not Yet Accepted", "proposed"), 3),
        ];
        let out = render_catalog_snapshot(&nodes, 4224, CATALOG_SNAPSHOT_MAX_BYTES);
        assert!(out.contains("- redline [root] (40 links) project=/x/redline"));
        assert!(out.contains("  - Loop Engineering [kid] (12 links)"));
        // A root's project binding rides along; a child's does not repeat it.
        assert!(!out.contains("Loop Engineering [kid] (12 links) project="));
        // Digest nodes say what they hold.
        assert!(out.contains("digest: the old loop work, collapsed"));
        // Proposed nodes are not the catalog.
        assert!(!out.contains("Not Yet Accepted"));
    }

    /// Truncation drops the DEEPEST levels first: a lost leaf costs the agent
    /// one descent, a lost root would hide a whole class.
    #[test]
    fn catalog_snapshot_drops_the_deepest_levels_first() {
        let n = |id: &str, parent: Option<&str>| ClassNode {
            id: id.into(),
            parent_id: parent.map(str::to_string),
            kind: "node".into(),
            title: format!("title-of-{id}"),
            summary: None,
            project_path: None,
            ip_name: None,
            status: "accepted".into(),
            pinned: false,
            curated_by: None,
            created_at: 0,
            updated_at: 0,
        };
        let mut nodes = vec![(n("root", None), 1i64)];
        for i in 0..80 {
            nodes.push((n(&format!("mid{i}"), Some("root")), 1));
            nodes.push((n(&format!("leaf{i}"), Some(&format!("mid{i}"))), 1));
        }
        let full = render_catalog_snapshot(&nodes, 1, CATALOG_SNAPSHOT_MAX_BYTES);
        assert!(full.contains("title-of-leaf0"), "it all fits at 12KB");

        // A budget that can't hold the leaves keeps the roots and mids.
        let tight = render_catalog_snapshot(&nodes, 1, 3_000);
        assert!(tight.len() <= 3_000, "the snapshot must respect its budget");
        assert!(tight.contains("title-of-root"));
        assert!(tight.contains("title-of-mid0"));
        assert!(!tight.contains("title-of-leaf0"), "deepest level dropped first");
        assert!(tight.contains("more node(s) not shown"));

        // A budget that can't even hold the roots still returns something
        // bounded rather than blowing the prompt.
        let brutal = render_catalog_snapshot(&nodes, 1, 400);
        assert!(brutal.len() <= 400);
        assert!(brutal.contains("title-of-root"));
    }

    #[test]
    fn catalog_snapshot_says_so_when_the_catalog_is_empty() {
        let out = render_catalog_snapshot(&[], 99, CATALOG_SNAPSHOT_MAX_BYTES);
        assert!(out.contains("catalog is empty"));
        assert!(out.contains("seq 99"));
    }

}
