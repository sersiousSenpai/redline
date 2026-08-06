// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Memory as plumbing — the background **keeper**.
//!
//! Redline captures everything while it's warm (the hash-chained lake) and an
//! agent organizes it into the ClassMemory catalog. The keeper makes both of
//! those *automatic and invisible*: on a slow tick it waits for the app to go
//! idle, then — when the lake has grown enough — it runs one `organize_once`
//! pass and, behind it, a **compaction pass** that behaves like human memory.
//! As classified data goes cold and the store grows, the keeper compacts the
//! *specifics* of a cold prompt into a gist while the ledger retains the
//! tamper-evident *fact that it happened* (`db::compact_prompt_body`). Size ×
//! coldness × recency drive the pressure; pins are an absolute veto.
//!
//! No buttons, no configs. The whole surface is one quiet status pill; this
//! module is the engine under it. It is deliberately best-effort — every step
//! logs on error and never panics the loop, and it never runs while a terminal
//! is producing output or a prompt just landed, so it stays off the user's hot
//! path. The compaction *intelligence* is the dissolved Librarian's brain,
//! repurposed here to **act** (emit gists) instead of advise.

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::classmem::{self, auto_collapse_safe, subtree_stats, ClassNode};
use crate::claude_proc::{classify_line, resolve_claude_bin, StreamLine};
use crate::db::Database;
use crate::ledger::{self, now_millis};

// --- Tunables (code-only; nothing is exposed to the user) ------------------

/// How often the keeper wakes to consider a run.
/// The actor the keeper authors its ledger events (compaction, observations)
/// as — its seat name (`seat::KNOWN_SEATS`), so autonomous writes are
/// separable from the human's in the chain.
const KEEPER_ACTOR: &str = "keeper";

const TICK: std::time::Duration = std::time::Duration::from_secs(30);
/// New ledger events since the last organize that trigger a run on their own.
const GROWTH_THRESHOLD: i64 = 25;
/// A floor so a slow trickle still gets organized/compacted eventually (6h of
/// lake-time — measured against the newest event, like all coldness here).
const MAX_INTERVAL_MS: i64 = 6 * 3600 * 1000;
/// Quiet window: no PTY output and no new prompt for this long ⇒ idle.
const IDLE_WINDOW_MS: i64 = 90 * 1000;
/// Never run two passes closer together than this (debounce).
const MIN_INTERVAL_MS: i64 = 10 * 60 * 1000;
/// A prompt smaller than this isn't worth gisting.
const SIZE_FLOOR_BYTES: i64 = 2048;
/// Cap prompts fed to one summarizer spawn (keeps the baked prompt bounded).
const MAX_BATCH: usize = 40;
/// Byte bound on the summarizer's baked-in corpus.
const MAX_CORPUS_BYTES: usize = 60_000;
/// Deterministic-fallback gist keeps this many leading characters.
const GIST_HEAD_CHARS: usize = 240;
/// Run one observation pass per this many completed organize passes (the
/// counter persists in settings so cadence survives restarts).
const OBSERVE_EVERY_N_ORGANIZES: i64 = 5;
/// A node needs at least this many ledger-resolvable links to be mined.
const OBSERVE_MIN_ITEMS: i64 = 5;
/// Nodes mined per pass (bounds the baked corpus + spawn cost).
const OBSERVE_MAX_NODES: usize = 3;
/// Per-node cap on corpus items fed to the observation prompt.
const OBSERVE_MAX_ITEMS_PER_NODE: i64 = 40;
/// Settings key for the organize-pass counter behind the observation cadence.
const OBSERVE_COUNTER_KEY: &str = "redline.keeper.observeCounter";

// ---------------------------------------------------------------------------
// Idle gate (pure)
// ---------------------------------------------------------------------------

/// The app is idle for the keeper's purposes when BOTH signals have been quiet
/// for `window_ms`: no terminal output (`last_pty_ms`) and no freshly-captured
/// prompt (`lake_newest_ms`, the newest ledger `ts`). A `0` for either means
/// "never happened" and counts as quiet. Coldness elsewhere is lake-relative,
/// but *idleness* is a real wall-clock "is the user here right now" question, so
/// it compares against `now_ms` (wall clock).
pub fn is_idle(last_pty_ms: i64, lake_newest_ms: i64, now_ms: i64, window_ms: i64) -> bool {
    let pty_quiet = last_pty_ms <= 0 || now_ms - last_pty_ms >= window_ms;
    let lake_quiet = lake_newest_ms <= 0 || now_ms - lake_newest_ms >= window_ms;
    pty_quiet && lake_quiet
}

// ---------------------------------------------------------------------------
// Compaction candidate selection (pure)
// ---------------------------------------------------------------------------

/// A warm prompt with the accepted class nodes it is linked into.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptCand {
    pub prompt_id: i64,
    pub bytes: i64,
    pub node_ids: Vec<String>,
}

/// Fold the flat `(prompt_id, bytes, node_id)` rows from
/// `Database::list_compaction_candidates` into one `PromptCand` per prompt.
pub fn group_candidates(rows: Vec<(i64, i64, String)>) -> Vec<PromptCand> {
    let mut by_id: HashMap<i64, PromptCand> = HashMap::new();
    for (id, bytes, node) in rows {
        let e = by_id.entry(id).or_insert_with(|| PromptCand {
            prompt_id: id,
            bytes,
            node_ids: Vec::new(),
        });
        e.bytes = e.bytes.max(bytes);
        if !e.node_ids.contains(&node) {
            e.node_ids.push(node);
        }
    }
    let mut out: Vec<PromptCand> = by_id.into_values().collect();
    out.sort_by_key(|c| c.prompt_id); // deterministic order (no wall-clock/rng)
    out
}

/// The pin-protected node set: every pinned node plus all of its descendants.
/// A pin is an absolute anti-decay veto for the whole subtree beneath it. (A
/// prompt linked to an *ancestor* of a pin is already excluded upstream, because
/// `subtree_stats` rolls a descendant's pin up and `auto_collapse_safe` then
/// refuses that ancestor — so it never enters the cold set.)
pub fn pin_protected_nodes(nodes: &[ClassNode]) -> HashSet<String> {
    let mut kids: HashMap<&str, Vec<&str>> = HashMap::new();
    for n in nodes {
        if let Some(p) = &n.parent_id {
            kids.entry(p.as_str()).or_default().push(n.id.as_str());
        }
    }
    let mut protected: HashSet<String> = HashSet::new();
    for n in nodes.iter().filter(|n| n.pinned) {
        // BFS the subtree rooted at the pinned node.
        let mut stack = vec![n.id.as_str()];
        let mut guard = 0;
        while let Some(id) = stack.pop() {
            guard += 1;
            if guard > 100_000 {
                break; // defensive cycle guard
            }
            if protected.insert(id.to_string()) {
                if let Some(cs) = kids.get(id) {
                    stack.extend(cs.iter().copied());
                }
            }
        }
    }
    protected
}

/// Select prompt ids to compact: big enough, linked into at least one COLD node,
/// and not linked into any PROTECTED (pinned-subtree) node. Deterministic.
pub fn select_compaction_candidates(
    cands: &[PromptCand],
    cold_nodes: &HashSet<String>,
    protected: &HashSet<String>,
    size_floor: i64,
) -> Vec<i64> {
    cands
        .iter()
        .filter(|c| c.bytes >= size_floor)
        .filter(|c| !c.node_ids.iter().any(|n| protected.contains(n)))
        .filter(|c| c.node_ids.iter().any(|n| cold_nodes.contains(n)))
        .map(|c| c.prompt_id)
        .collect()
}

// ---------------------------------------------------------------------------
// Gist generation — tiered (agent summarizer, deterministic fallback)
// ---------------------------------------------------------------------------

/// One compaction the keeper will apply.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionAction {
    pub prompt_id: i64,
    pub gist: String,
    pub reason: String,
}

/// Deterministic gist for when the agent summarizer is unavailable or its reply
/// won't parse — compaction must never hard-depend on `claude` being installed.
/// Keeps the leading `GIST_HEAD_CHARS` and records what was released.
pub fn deterministic_gist(body: &str) -> String {
    let bytes = body.len();
    let head: String = body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(GIST_HEAD_CHARS)
        .collect();
    format!("{head}… [compacted {bytes} bytes]")
}

/// Build the summarizer's first-turn prompt: the cold prompt bodies (byte-
/// bounded) + a strict JSON output contract. Self-contained (no curl needed).
pub fn build_keeper_prompt(prompts: &[(i64, String)]) -> String {
    let mut p = String::new();
    p.push_str(
        "You are Redline's memory keeper. The prompts below have gone COLD in the \
         user's history and are being compacted to reclaim space — like human \
         memory keeping the gist of an old conversation, not its every word.\n\n\
         For EACH prompt, write a compact gist (1–3 sentences) that preserves what \
         it was about, any decision or intent it carried, and enough to answer \
         \"what did I do/decide about this\" later. Drop verbatim detail. Never \
         invent; if a prompt is trivial, a one-line gist is fine.\n\n\
         ## Cold prompts\n\n",
    );
    let mut used = 0usize;
    for (id, body) in prompts {
        let one = body.replace('\n', " ");
        let snippet: String = one.chars().take(3000).collect();
        let block = format!("### prompt {id}\n{snippet}\n\n");
        if used + block.len() > MAX_CORPUS_BYTES {
            break;
        }
        used += block.len();
        p.push_str(&block);
    }
    p.push_str(
        "## Output\n\nReturn ONLY a JSON object (optionally in a ```json fence), \
         one entry per prompt you gisted:\n\n\
         {\"actions\":[{\"promptId\":<id>,\"gist\":\"<1–3 sentence gist>\",\"reason\":\"cold\"}]}\n",
    );
    p
}

/// Parse the summarizer's reply into actions. Tolerant like the classifier's
/// parser: first balanced `{…}` that carries an `actions` array; drops entries
/// with no id or an empty gist. Pure.
pub fn parse_compaction_actions(text: &str) -> Vec<CompactionAction> {
    let Some(obj) = extract_object_with_key(text, "actions") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(arr) = obj.get("actions").and_then(Value::as_array) {
        for v in arr {
            let prompt_id = match v.get("promptId") {
                Some(Value::Number(n)) => n.as_i64(),
                Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
                _ => None,
            };
            let gist = v
                .get("gist")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let (Some(prompt_id), Some(gist)) = (prompt_id, gist) else {
                continue;
            };
            let reason = v
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("cold")
                .to_string();
            out.push(CompactionAction {
                prompt_id,
                gist: gist.to_string(),
                reason,
            });
        }
    }
    out
}

/// First top-level `{…}` substring that parses as JSON and carries `key`.
/// Shared with classmem's supersede-verifier parser.
pub(crate) fn extract_object_with_key(text: &str, key: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = matching_brace(bytes, i) {
                if let Ok(v) = serde_json::from_str::<Value>(&text[i..=end]) {
                    if v.get(key).is_some() {
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

/// Run the summarizer headless to completion, returning its final text. Same
/// MCP-stripped `bridge_args` spawn as the classifier/Librarian; the corpus is
/// baked into `prompt` so it never depends on the agent curling. Registers the
/// prompt with the dedup guard first so the headless `-p` doesn't leak into the
/// lake via the global hook.
pub async fn run_keeper_summarizer(cwd: &str, prompt: String) -> Result<String, String> {
    let claude_bin = tokio::task::spawn_blocking(resolve_claude_bin)
        .await
        .map_err(|e| e.to_string())?;
    ledger::register_agent_prompt(&ledger::body_hash(&prompt));
    let args = crate::claude_proc::bridge_args("keeper", prompt, None);
    let mut cmd = crate::claude_proc::claude_command_for_seat("keeper", &claude_bin);
    let mut child = cmd
        .current_dir(cwd)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn the keeper summarizer: {e}"))?;
    let stdout = child.stdout.take().ok_or("summarizer stdout unavailable")?;
    let mut reader = BufReader::new(stdout).lines();
    let mut final_text: Option<String> = None;
    let mut errored: Option<String> = None;
    while let Ok(Some(line)) = reader.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match classify_line(&v) {
            StreamLine::Final { text, .. } => final_text = Some(text),
            StreamLine::Failed(msg) => errored = Some(msg),
            _ => {}
        }
    }
    let _ = child.wait().await;
    if let Some(msg) = errored {
        return Err(msg);
    }
    final_text.ok_or_else(|| "summarizer produced no output".to_string())
}

// ---------------------------------------------------------------------------
// The compaction pass
// ---------------------------------------------------------------------------

/// Run one compaction pass. Selects cold, big, unpinned classified prompts,
/// gists them (agent-first, deterministic fallback), and applies each via
/// `compact_prompt_body` (which emits the tamper-evident ledger event). Returns
/// how many bodies were compacted. Best-effort: a summarizer failure degrades
/// to deterministic gists rather than skipping the pass.
pub async fn compaction_pass(db: &Database) -> Result<usize, String> {
    let env = db.lake_envelope().map_err(|e| e.to_string())?;
    let nodes = db.list_class_nodes().map_err(|e| e.to_string())?;
    let direct = db.node_direct_link_activity().map_err(|e| e.to_string())?;
    let stats = subtree_stats(&nodes, &direct);

    let cold_nodes: HashSet<String> = stats
        .iter()
        .filter(|(_, s)| auto_collapse_safe(s, env))
        .map(|(id, _)| id.clone())
        .collect();
    let protected = pin_protected_nodes(&nodes);

    let rows = db
        .list_compaction_candidates(SIZE_FLOOR_BYTES)
        .map_err(|e| e.to_string())?;
    let cands = group_candidates(rows);
    let mut selected = select_compaction_candidates(&cands, &cold_nodes, &protected, SIZE_FLOOR_BYTES);
    if selected.is_empty() {
        return Ok(0);
    }
    selected.truncate(MAX_BATCH);

    let bodies = db.get_prompt_bodies(&selected).map_err(|e| e.to_string())?;
    if bodies.is_empty() {
        return Ok(0);
    }
    let body_map: HashMap<i64, String> = bodies.iter().cloned().collect();

    // Tier 1: the agent summarizer acts. Tier 2 (fallback): deterministic gist
    // for any prompt the agent didn't cover (or if it failed entirely).
    let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let mut gists: HashMap<i64, (String, String)> = HashMap::new();
    match run_keeper_summarizer(&cwd, build_keeper_prompt(&bodies)).await {
        Ok(text) => {
            for a in parse_compaction_actions(&text) {
                if body_map.contains_key(&a.prompt_id) {
                    gists.insert(a.prompt_id, (a.gist, a.reason));
                }
            }
        }
        Err(e) => tracing::info!(error = %e, "keeper summarizer unavailable — deterministic gists"),
    }
    for (id, body) in &bodies {
        gists
            .entry(*id)
            .or_insert_with(|| (deterministic_gist(body), "cold".to_string()));
    }

    let mut applied = 0usize;
    for (id, (gist, reason)) in &gists {
        match db.compact_prompt_body(*id, gist, reason, KEEPER_ACTOR) {
            Ok(Some(_)) => applied += 1,
            Ok(None) => {} // raced / already compacted
            Err(e) => tracing::warn!(error = %e, prompt = id, "compact_prompt_body failed"),
        }
    }
    Ok(applied)
}

// ---------------------------------------------------------------------------
// Observation pass (agent-derived patterns over a node's items)
// ---------------------------------------------------------------------------

/// One observation the pass will write.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservationAction {
    pub node_id: String,
    pub summary: String,
    pub cite_seqs: Vec<i64>,
}

/// Pick the nodes worth mining this pass: accepted, not a digest, holding at
/// least `min_items` ledger-resolvable items, and with something NEW since
/// their newest observation (freshness — never re-mine a quiet node). Ranked
/// by last activity (recently active nodes have live patterns), truncated to
/// `max`. Pure and deterministic.
pub fn select_observation_nodes(
    nodes: &[ClassNode],
    stats: &HashMap<String, classmem::BranchStat>,
    newest_obs: &HashMap<String, i64>,
    min_items: i64,
    max: usize,
) -> Vec<String> {
    let mut cands: Vec<(&str, i64)> = nodes
        .iter()
        .filter(|n| n.status == "accepted" && n.kind != "digest")
        .filter_map(|n| {
            let s = stats.get(&n.id)?;
            if s.item_count < min_items {
                return None;
            }
            let last = s.last_ts?;
            if newest_obs.get(&n.id).is_some_and(|&obs| obs >= last) {
                return None; // nothing new since the last observation
            }
            Some((n.id.as_str(), last))
        })
        .collect();
    cands.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    cands.truncate(max);
    cands.into_iter().map(|(id, _)| id.to_string()).collect()
}

/// Build the observation prompt. Self-contained like `build_keeper_prompt` —
/// the corpus is baked in, no skill load, no curling. Every observation must
/// cite the exact seqs it derives from; uncited output is rejected.
pub fn build_observations_prompt(
    corpus: &[(String, String, Vec<(i64, String, i64, Option<String>)>)],
) -> String {
    let mut p = String::from(
        "You are Redline's memory keeper, observation pass. For each class of \
         the user's history below, look ACROSS its items for a PATTERN — a \
         recurrence, a trend over time, or a co-occurrence (e.g. \"every deploy \
         prompt lands within a day of an auth change\"). An observation is a \
         DERIVED note, never ground truth — phrase it as a pattern, not a fact \
         or decision. Every observation MUST cite the exact seqs it derives \
         from — uncited observations are rejected. If a class shows no genuine \
         pattern, emit nothing for it. At most one observation per class.\n\n",
    );
    let mut used = p.len();
    for (node_id, title, items) in corpus {
        let mut block = format!("### node {node_id} — {title}\n");
        for (seq, kind, ts, snippet) in items {
            block.push_str(&format!(
                "- seq {seq} | {kind} | ts={ts} | {}\n",
                snippet.as_deref().map(|s| {
                    let one = s.replace('\n', " ");
                    one.chars().take(200).collect::<String>()
                })
                .unwrap_or_else(|| format!("[{kind} event]")),
            ));
        }
        block.push('\n');
        if used + block.len() > MAX_CORPUS_BYTES {
            break;
        }
        used += block.len();
        p.push_str(&block);
    }
    p.push_str(
        "## Output\n\nReturn ONLY a JSON object (optionally in a ```json fence):\n\n\
         {\"observations\":[{\"nodeId\":\"<node id>\",\"summary\":\"<1–2 sentence pattern>\",\"citeSeqs\":[<seqs from that node's items>]}]}\n",
    );
    p
}

/// Parse the observation reply — deliberately STRICTER than the compaction
/// parser: entries with an empty summary, empty `citeSeqs`, an unknown
/// `nodeId`, or any cited seq that was not actually shown to the agent for
/// that node (fabricated citation) are dropped. Numeric strings coerce. Pure.
pub fn parse_observations(
    text: &str,
    allowed: &HashMap<String, HashSet<i64>>,
) -> Vec<ObservationAction> {
    let Some(obj) = extract_object_with_key(text, "observations") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(arr) = obj.get("observations").and_then(Value::as_array) {
        for v in arr {
            let Some(node_id) = v
                .get("nodeId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let Some(shown) = allowed.get(node_id) else {
                continue; // unknown node — fabricated or stale
            };
            let Some(summary) = v
                .get("summary")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let cite_seqs: Vec<i64> = v
                .get("citeSeqs")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| match x {
                            Value::Number(n) => n.as_i64(),
                            Value::String(s) => s.trim().parse().ok(),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            // An uncited pattern is fabrication; a citation outside what the
            // agent was shown is fabrication too.
            if cite_seqs.is_empty() || cite_seqs.iter().any(|s| !shown.contains(s)) {
                continue;
            }
            out.push(ObservationAction {
                node_id: node_id.to_string(),
                summary: summary.to_string(),
                cite_seqs,
            });
        }
    }
    out
}

/// The keeper's third idle-tick pass: mine a few active, item-rich nodes for
/// patterns and write them as `class_observations` rows (each appending its
/// `observation` ledger event). No deterministic fallback — an observation is
/// pure judgment, so if the agent is unavailable the pass just skips.
pub async fn observations_pass(db: &Database) -> Result<usize, String> {
    let nodes = db.list_class_nodes().map_err(|e| e.to_string())?;
    let direct = db.node_direct_link_activity().map_err(|e| e.to_string())?;
    let stats = subtree_stats(&nodes, &direct);
    let newest_obs = db.newest_observation_per_node().map_err(|e| e.to_string())?;
    let selected = select_observation_nodes(
        &nodes,
        &stats,
        &newest_obs,
        OBSERVE_MIN_ITEMS,
        OBSERVE_MAX_NODES,
    );
    if selected.is_empty() {
        return Ok(0);
    }
    let title_of: HashMap<&str, &str> = nodes
        .iter()
        .map(|n| (n.id.as_str(), n.title.as_str()))
        .collect();
    let mut corpus = Vec::new();
    let mut allowed: HashMap<String, HashSet<i64>> = HashMap::new();
    for node_id in &selected {
        let items = db
            .node_link_items(node_id, OBSERVE_MAX_ITEMS_PER_NODE)
            .map_err(|e| e.to_string())?;
        if (items.len() as i64) < OBSERVE_MIN_ITEMS {
            continue; // links resolved to fewer ledger rows than the gate
        }
        allowed.insert(node_id.clone(), items.iter().map(|(seq, ..)| *seq).collect());
        corpus.push((
            node_id.clone(),
            title_of.get(node_id.as_str()).copied().unwrap_or("").to_string(),
            items,
        ));
    }
    if corpus.is_empty() {
        return Ok(0);
    }
    let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let text = match run_keeper_summarizer(&cwd, build_observations_prompt(&corpus)).await {
        Ok(text) => text,
        Err(e) => {
            tracing::info!(error = %e, "observation agent unavailable — skipping the pass");
            return Ok(0);
        }
    };
    let mut written = 0usize;
    for a in parse_observations(&text, &allowed) {
        match db.insert_class_observation(&a.node_id, &a.summary, &a.cite_seqs, KEEPER_ACTOR) {
            Ok(Some(_)) => written += 1,
            Ok(None) => {} // dedup (incl. previously dismissed) or node gone
            Err(e) => tracing::warn!(error = %e, node = %a.node_id, "insert observation failed"),
        }
    }
    Ok(written)
}

// ---------------------------------------------------------------------------
// The scheduler loop
// ---------------------------------------------------------------------------

/// Spawn the background keeper. Wakes every `TICK`; on each wake it organizes +
/// compacts only when the growth, idle, and debounce gates all pass. Async
/// because the classifier/summarizer are async; runs on the Tauri runtime.
pub fn spawn(app: AppHandle, db: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        let mut last_run_ms: Option<i64> = None;
        loop {
            tokio::time::sleep(TICK).await;
            let now = now_millis();

            // --- idle gate ---
            let lake_newest = db.lake_envelope().map(|e| e.newest).unwrap_or(0);
            if !is_idle(crate::pty::last_pty_output_ms(), lake_newest, now, IDLE_WINDOW_MS) {
                continue; // a terminal or the user is active — stay off the hot path
            }
            // --- debounce ---
            if let Some(last) = last_run_ms {
                if now - last < MIN_INTERVAL_MS {
                    continue;
                }
            }
            // --- growth gate ---
            let backlog = {
                let max = db.max_ledger_seq().unwrap_or(0);
                let last_to = db.last_run_seq_to().unwrap_or(0);
                (max - last_to).max(0)
            };
            let due_by_time = last_run_ms.map(|l| now - l >= MAX_INTERVAL_MS).unwrap_or(true);
            if backlog == 0 || (backlog < GROWTH_THRESHOLD && !due_by_time) {
                continue; // not enough new material yet
            }

            // --- run: organize, then compact, then (occasionally) observe.
            // All best-effort. ---
            let mut organized = false;
            match classmem::organize_once(&db).await {
                Ok(o) if o.ran => {
                    organized = true;
                    tracing::info!(summary = %o.summary, "keeper organized");
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "keeper organize pass failed"),
            }
            match compaction_pass(&db).await {
                Ok(n) if n > 0 => tracing::info!(compacted = n, "keeper compacted cold prompts"),
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "keeper compaction pass failed"),
            }
            // Observation cadence: one pass per OBSERVE_EVERY_N_ORGANIZES
            // organizes that actually ran (counter persists across restarts).
            if organized {
                let n = db
                    .get_setting(OBSERVE_COUNTER_KEY)
                    .and_then(|v| v.parse::<i64>().ok())
                    .unwrap_or(0)
                    + 1;
                if n >= OBSERVE_EVERY_N_ORGANIZES {
                    match observations_pass(&db).await {
                        Ok(k) if k > 0 => tracing::info!(observations = k, "keeper observed patterns"),
                        Ok(_) => {}
                        Err(e) => tracing::warn!(error = %e, "keeper observation pass failed"),
                    }
                    let _ = db.set_setting(OBSERVE_COUNTER_KEY, "0");
                } else {
                    let _ = db.set_setting(OBSERVE_COUNTER_KEY, &n.to_string());
                }
            }

            last_run_ms = Some(now_millis());
            let _ = app.emit("memory-changed", ());
            let _ = app.emit("classmem-changed", ());
            let _ = app.emit("ledger-changed", ());
            crate::extension_host::publish(
                redline_extension_abi::events::LEDGER_CHANGED,
                &redline_extension_abi::events::LedgerChanged {
                    ts_ms: crate::extension_host::now_ms(),
                },
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, parent: Option<&str>, pinned: bool) -> ClassNode {
        ClassNode {
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
        }
    }

    #[test]
    fn is_idle_truth_table() {
        let now = 1_000_000;
        let w = 90_000;
        // both quiet (long ago) → idle
        assert!(is_idle(now - 200_000, now - 200_000, now, w));
        // pty just spoke → not idle
        assert!(!is_idle(now - 1_000, now - 200_000, now, w));
        // a prompt just landed → not idle
        assert!(!is_idle(now - 200_000, now - 1_000, now, w));
        // never-happened zeros count as quiet
        assert!(is_idle(0, 0, now, w));
        // exactly at the window boundary counts as quiet
        assert!(is_idle(now - w, now - w, now, w));
    }

    #[test]
    fn group_candidates_folds_by_prompt_and_is_ordered() {
        let rows = vec![
            (2, 100, "b".into()),
            (1, 500, "a".into()),
            (1, 500, "b".into()),
        ];
        let g = group_candidates(rows);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].prompt_id, 1); // sorted
        assert_eq!(g[0].node_ids.len(), 2); // a + b folded
        assert_eq!(g[1].prompt_id, 2);
    }

    #[test]
    fn pin_protects_the_whole_subtree() {
        let nodes = vec![
            node("root", None, false),
            node("mid", Some("root"), true), // pinned
            node("leaf", Some("mid"), false),
            node("other", Some("root"), false),
        ];
        let p = pin_protected_nodes(&nodes);
        assert!(p.contains("mid") && p.contains("leaf"));
        assert!(!p.contains("root") && !p.contains("other"));
    }

    #[test]
    fn select_picks_cold_big_unpinned_and_skips_the_rest() {
        let cands = vec![
            // cold + big + unprotected → picked
            PromptCand { prompt_id: 1, bytes: 5000, node_ids: vec!["cold".into()] },
            // too small → skipped
            PromptCand { prompt_id: 2, bytes: 100, node_ids: vec!["cold".into()] },
            // not cold → skipped
            PromptCand { prompt_id: 3, bytes: 5000, node_ids: vec!["warm".into()] },
            // pinned/protected → skipped even though cold+big
            PromptCand { prompt_id: 4, bytes: 5000, node_ids: vec!["cold".into(), "pinned".into()] },
        ];
        let cold: HashSet<String> = ["cold".to_string()].into_iter().collect();
        let protected: HashSet<String> = ["pinned".to_string()].into_iter().collect();
        let picked = select_compaction_candidates(&cands, &cold, &protected, SIZE_FLOOR_BYTES);
        assert_eq!(picked, vec![1]);
    }

    #[test]
    fn parse_actions_tolerates_prose_and_coerces_ids() {
        let text = r#"Here you go:
```json
{"actions":[
  {"promptId":7,"gist":"Decided to use Yjs.","reason":"cold"},
  {"promptId":"8","gist":"  Auth spike notes  "},
  {"promptId":9,"gist":"   "},
  {"gist":"no id so dropped"}
]}
```"#;
        let a = parse_compaction_actions(text);
        assert_eq!(a.len(), 2, "empty-gist and id-less entries dropped");
        assert_eq!(a[0].prompt_id, 7);
        assert_eq!(a[1].prompt_id, 8); // numeric-string coerced
        assert_eq!(a[1].gist, "Auth spike notes"); // trimmed
        assert_eq!(a[1].reason, "cold"); // defaulted
        assert!(parse_compaction_actions("no json").is_empty());
    }

    #[test]
    fn parse_observations_rejects_uncited_and_foreign_seqs() {
        let mut allowed: HashMap<String, HashSet<i64>> = HashMap::new();
        allowed.insert("cn-a".into(), [10, 11, 12].into_iter().collect());
        let text = r#"Patterns found:
```json
{"observations":[
  {"nodeId":"cn-a","summary":"deploys follow auth changes","citeSeqs":[10,"11"]},
  {"nodeId":"cn-a","summary":"uncited pattern","citeSeqs":[]},
  {"nodeId":"cn-a","summary":"fabricated citation","citeSeqs":[10,99]},
  {"nodeId":"cn-ghost","summary":"unknown node","citeSeqs":[10]},
  {"nodeId":"cn-a","summary":"   ","citeSeqs":[10]}
]}
```"#;
        let obs = parse_observations(text, &allowed);
        assert_eq!(obs.len(), 1, "uncited / foreign-seq / unknown-node / blank all dropped");
        assert_eq!(obs[0].node_id, "cn-a");
        assert_eq!(obs[0].cite_seqs, vec![10, 11]); // numeric-string coerced
        assert!(parse_observations("prose", &allowed).is_empty());
    }

    #[test]
    fn select_observation_nodes_gates_on_size_freshness_and_kind() {
        let mut digest = node("digest", None, false);
        digest.kind = "digest".into();
        let mut proposed = node("proposed", None, false);
        proposed.status = "proposed".into();
        let nodes = vec![
            node("busy", None, false),     // active + big → picked first
            node("older", None, false),    // active + big, older → picked second
            node("tiny", None, false),     // too few items
            node("stale", None, false),    // observation newer than last activity
            digest,                        // digests are never mined
            proposed,                      // unaccepted nodes are never mined
        ];
        let stat = |count: i64, ts: i64| classmem::BranchStat {
            last_ts: Some(ts),
            item_count: count,
            pinned: false,
        };
        let stats: HashMap<String, classmem::BranchStat> = [
            ("busy".to_string(), stat(10, 900)),
            ("older".to_string(), stat(8, 500)),
            ("tiny".to_string(), stat(2, 950)),
            ("stale".to_string(), stat(9, 400)),
            ("digest".to_string(), stat(9, 990)),
            ("proposed".to_string(), stat(9, 990)),
        ]
        .into_iter()
        .collect();
        let newest_obs: HashMap<String, i64> = [("stale".to_string(), 450)].into_iter().collect();
        let picked = select_observation_nodes(&nodes, &stats, &newest_obs, OBSERVE_MIN_ITEMS, 2);
        assert_eq!(picked, vec!["busy".to_string(), "older".to_string()]);
        // With room for more, the gated nodes still never appear.
        let all = select_observation_nodes(&nodes, &stats, &newest_obs, OBSERVE_MIN_ITEMS, 10);
        assert_eq!(all, vec!["busy".to_string(), "older".to_string()]);
    }

    #[test]
    fn observations_prompt_carries_the_citation_contract() {
        let corpus = vec![(
            "cn-a".to_string(),
            "Auth".to_string(),
            vec![(10, "prompt".to_string(), 900, Some("clerk webhook".to_string()))],
        )];
        let p = build_observations_prompt(&corpus);
        assert!(p.contains("observations"));
        assert!(p.contains("citeSeqs"));
        assert!(p.contains("uncited observations are rejected"));
        assert!(p.contains("### node cn-a — Auth"));
        assert!(p.contains("seq 10"));
    }

    #[test]
    fn deterministic_gist_marks_reclaimed_bytes() {
        let body = "word ".repeat(200); // 1000 bytes
        let g = deterministic_gist(&body);
        assert!(g.contains("[compacted 1000 bytes]"));
        assert!(g.chars().count() < body.chars().count());
    }
}
