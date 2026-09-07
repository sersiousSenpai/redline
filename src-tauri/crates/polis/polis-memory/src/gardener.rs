// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The memory passes the background gardener runs — compaction, observations — and the idle/debounce/growth gates around them, as one `step`. Lifted from Redline's `keeper.rs` in Session A5; the watch bus stays with the host.

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
use polis_core::gist::deterministic_gist;
#[allow(unused_imports)]
use polis_core::json::extract_object_with_key;

/// How often the keeper wakes to consider a run.
/// The actor the keeper authors its ledger events (compaction, observations)
/// as — its seat name (`seat::KNOWN_SEATS`), so autonomous writes are
/// separable from the human's in the chain.
pub const KEEPER_ACTOR: &str = "keeper";

/// New ledger events since the last organize that trigger a run on their own.
pub const GROWTH_THRESHOLD: i64 = 25;

/// A floor so a slow trickle still gets organized/compacted eventually (6h of
/// lake-time — measured against the newest event, like all coldness here).
pub const MAX_INTERVAL_MS: i64 = 6 * 3600 * 1000;

/// Quiet window: no PTY output and no new prompt for this long ⇒ idle.
pub const IDLE_WINDOW_MS: i64 = 90 * 1000;

/// Never run two passes closer together than this (debounce).
pub const MIN_INTERVAL_MS: i64 = 10 * 60 * 1000;

/// A prompt smaller than this isn't worth gisting.
pub const SIZE_FLOOR_BYTES: i64 = 2048;

/// Cap prompts fed to one summarizer spawn (keeps the baked prompt bounded).
pub const MAX_BATCH: usize = 40;

/// Byte bound on the summarizer's baked-in corpus.
pub const MAX_CORPUS_BYTES: usize = 60_000;

/// How long a machine-authored row (`agent`/`system`) stays warm. Measured in
/// lake time against the newest event, like every other coldness here — never
/// wall clock. Machine text has no class link to go cold *through*, so age is
/// the only signal it has; a week is long enough that anything still on screen
/// is untouched.
pub const MACHINE_COLD_MS: i64 = 7 * 24 * 3600 * 1000;

/// Run one observation pass per this many completed organize passes (the
/// counter persists in settings so cadence survives restarts).
pub const OBSERVE_EVERY_N_ORGANIZES: i64 = 5;

/// A node needs at least this many ledger-resolvable links to be mined.
pub const OBSERVE_MIN_ITEMS: i64 = 5;

/// Nodes mined per pass (bounds the baked corpus + spawn cost).
pub const OBSERVE_MAX_NODES: usize = 3;

/// Per-node cap on corpus items fed to the observation prompt.
pub const OBSERVE_MAX_ITEMS_PER_NODE: i64 = 40;

/// Settings key for the organize-pass counter behind the observation cadence.
pub const OBSERVE_COUNTER_KEY: &str = "polis.keeper.observeCounter";

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

/// A warm prompt with the accepted class nodes it is linked into.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptCand {
    pub prompt_id: i64,
    pub bytes: i64,
    /// The corpus role (`user` / `agent` / `system`), NULL-safe. This is what
    /// decides whether the row may be auto-compacted at all.
    pub role: String,
    pub node_ids: Vec<String>,
}

/// Fold the flat `(prompt_id, bytes, role, node_id)` rows from
/// `Database::list_compaction_candidates` into one `PromptCand` per prompt.
/// `node_id` is `None` for machine text, which has no class link to go cold
/// through and qualifies on age instead.
pub fn group_candidates(rows: Vec<(i64, i64, String, Option<String>)>) -> Vec<PromptCand> {
    let mut by_id: HashMap<i64, PromptCand> = HashMap::new();
    for (id, bytes, role, node) in rows {
        let e = by_id.entry(id).or_insert_with(|| PromptCand {
            prompt_id: id,
            bytes,
            role,
            node_ids: Vec::new(),
        });
        e.bytes = e.bytes.max(bytes);
        if let Some(node) = node {
            if !e.node_ids.contains(&node) {
                e.node_ids.push(node);
            }
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

/// Select prompt ids to compact: big enough, NOT the user's own words, not
/// linked into any PROTECTED (pinned-subtree) node, and cold — either through a
/// cold class node, or (for machine text, which has no class link) by the age
/// gate the SQL already applied. Deterministic.
///
/// The role filter is the substantive change. Compaction had been functioning as
/// a garbage collector for the capture leak: 224 rows compacted 3.6 MB → 60 KB,
/// irrecoverably, and ~207 of those 224 were machine text that should never have
/// been in the corpus at all. Reading that as "compaction works well" inverted
/// it — what it was doing well was deleting a bug's output, while the same 59:1
/// blade was pointed at the user's own prompts. Machine text is now the *only*
/// automatic target; a user row leaves only by an explicit `memory_forget`.
pub fn select_compaction_candidates(
    cands: &[PromptCand],
    cold_nodes: &HashSet<String>,
    protected: &HashSet<String>,
    size_floor: i64,
) -> Vec<i64> {
    cands
        .iter()
        .filter(|c| c.bytes >= size_floor)
        .filter(|c| c.role != "user")
        .filter(|c| !c.node_ids.iter().any(|n| protected.contains(n)))
        .filter(|c| c.node_ids.is_empty() || c.node_ids.iter().any(|n| cold_nodes.contains(n)))
        .map(|c| c.prompt_id)
        .collect()
}

/// Which tier wrote a gist, recorded on the row. The distinction only matters
/// after the fact — which is exactly when it was unavailable.
pub const GIST_SOURCE_AGENT: &str = "agent";

pub const GIST_SOURCE_DETERMINISTIC: &str = "deterministic";

/// One compaction the keeper will apply.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionAction {
    pub prompt_id: i64,
    pub gist: String,
    pub reason: String,
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

/// Run one compaction pass. Selects cold, big, unpinned classified prompts,
/// gists them (agent-first, deterministic fallback), and applies each via
/// `compact_prompt_body` (which emits the tamper-evident ledger event). Returns
/// how many bodies were compacted. Best-effort: a summarizer failure degrades
/// to deterministic gists rather than skipping the pass.
pub async fn compaction_pass(polis: &Polis<'_>) -> Result<usize, String> {
    let db = polis.store;
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
        .list_compaction_candidates(SIZE_FLOOR_BYTES, env.newest - MACHINE_COLD_MS)
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
    let mut gists: HashMap<i64, (String, String, &'static str)> = HashMap::new();
    match run_keeper_summarizer(polis, &cwd, build_keeper_prompt(&bodies)).await {
        Ok(text) => {
            for a in parse_compaction_actions(&text) {
                if body_map.contains_key(&a.prompt_id) {
                    gists.insert(a.prompt_id, (a.gist, a.reason, GIST_SOURCE_AGENT));
                }
            }
        }
        Err(e) => tracing::info!(error = %e, "keeper summarizer unavailable — deterministic gists"),
    }
    for (id, body) in &bodies {
        gists.entry(*id).or_insert_with(|| {
            (deterministic_gist(body), "cold".to_string(), GIST_SOURCE_DETERMINISTIC)
        });
    }

    let mut applied = 0usize;
    for (id, (gist, reason, source)) in &gists {
        match db.compact_prompt_body(*id, gist, reason, source, KEEPER_ACTOR) {
            Ok(Some(_)) => applied += 1,
            Ok(None) => {} // raced / already compacted
            Err(e) => tracing::warn!(error = %e, prompt = id, "compact_prompt_body failed"),
        }
    }
    Ok(applied)
}

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
    stats: &HashMap<String, polis_core::coldness::BranchStat>,
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
pub async fn observations_pass(polis: &Polis<'_>) -> Result<usize, String> {
    let db = polis.store;
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
    let text = match run_keeper_summarizer(polis, &cwd, build_observations_prompt(&corpus)).await {
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

/// Targets embedded per tick. Bounded so a cold start spreads over minutes
/// rather than pinning a core: the index is allowed to be late, never heavy.
pub const EMBED_BATCH: usize = 16;

// ---------------------------------------------------------------------------
// One tick of the gardener
// ---------------------------------------------------------------------------

use polis_core::host::{Change, Clock, GardenerEvents, IdleSignal};

/// The semantic index's cadence — the retired `embedding-index` watch's.
pub const EMBED_INDEX_EVERY_MS: i64 = 120 * 1000;

/// Cadences and gates. The defaults are Redline's keeper exactly as it ran.
#[derive(Debug, Clone)]
pub struct GardenerConfig {
    pub idle_window_ms: i64,
    pub min_interval_ms: i64,
    pub max_interval_ms: i64,
    pub growth_threshold: i64,
    pub embed_every_ms: i64,
    pub embed_batch: usize,
    pub observe_every_n_organizes: i64,
}

impl Default for GardenerConfig {
    fn default() -> Self {
        Self {
            idle_window_ms: IDLE_WINDOW_MS,
            min_interval_ms: MIN_INTERVAL_MS,
            max_interval_ms: MAX_INTERVAL_MS,
            growth_threshold: GROWTH_THRESHOLD,
            embed_every_ms: EMBED_INDEX_EVERY_MS,
            embed_batch: EMBED_BATCH,
            observe_every_n_organizes: OBSERVE_EVERY_N_ORGANIZES,
        }
    }
}

/// What persists between ticks (in memory — the observation counter lives in
/// `polis_meta`, so it survives a restart as it did in `app_settings`).
#[derive(Debug, Default, Clone)]
pub struct GardenerState {
    pub last_run_ms: Option<i64>,
    pub last_embed_ms: Option<i64>,
}

/// Which gate a tick stopped at, or that the passes ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Gate {
    /// A terminal or the user is active — the passes stay off the hot path.
    #[default]
    Busy,
    /// A run happened less than `min_interval_ms` ago.
    Debounced,
    /// The lake has not grown enough (and the max interval has not elapsed).
    NothingNew,
    Ran,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StepOutcome {
    pub gate: Gate,
    /// Targets embedded this tick (the index runs on its own cadence, before
    /// the memory gates, exactly as the retired watch did).
    pub embedded: usize,
    pub organized: bool,
    pub compacted: usize,
    pub observed: usize,
    /// A model pass was asked for and the install has no model (R12): the
    /// deterministic tiers ran, nothing errored.
    pub no_model: bool,
}

/// One tick: the semantic index on its own cadence, then idle → debounce →
/// growth → organize → compact → (every Nth organize) observe → events. The
/// host calls this from its scheduler (Redline: the keeper's 30 s loop) and
/// keeps the watch bus of its own.
pub async fn step(
    polis: &Polis<'_>,
    state: &mut GardenerState,
    idle: &dyn IdleSignal,
    clock: &dyn Clock,
    cfg: &GardenerConfig,
    events: &dyn GardenerEvents,
) -> StepOutcome {
    let now = clock.now_ms();
    let mut out = StepOutcome::default();
    let lake_newest = polis.store.lake_envelope().map(|e| e.newest).unwrap_or(0);
    let idle_now = is_idle(idle.last_activity_ms(), lake_newest, now, cfg.idle_window_ms);

    // --- the semantic index: idle-gated, its own cadence, cheap predicate ---
    if idle_now && state.last_embed_ms.map(|l| now - l >= cfg.embed_every_ms).unwrap_or(true) {
        if let Some(embedder) = polis.embedder.as_deref() {
            state.last_embed_ms = Some(now);
            let pending = polis
                .store
                .embedding_stats(&embedder.model_id())
                .map(|(_, pending)| pending > 0)
                .unwrap_or(false);
            if pending {
                let done = crate::index_tick(polis, cfg.embed_batch);
                if done > 0 {
                    tracing::info!(targets = done, "embedded a batch for the semantic arm");
                    out.embedded = done;
                    events.changed(&[Change::Embeddings]);
                }
            }
        }
    }

    // --- idle gate ---
    if !idle_now {
        out.gate = Gate::Busy;
        return out;
    }
    // --- debounce ---
    if let Some(last) = state.last_run_ms {
        if now - last < cfg.min_interval_ms {
            out.gate = Gate::Debounced;
            return out;
        }
    }
    // --- growth gate ---
    let backlog = {
        let max = polis.store.max_ledger_seq().unwrap_or(0);
        let last_to = polis.store.last_run_seq_to().unwrap_or(0);
        (max - last_to).max(0)
    };
    let due_by_time = state.last_run_ms.map(|l| now - l >= cfg.max_interval_ms).unwrap_or(true);
    if backlog == 0 || (backlog < cfg.growth_threshold && !due_by_time) {
        out.gate = Gate::NothingNew;
        return out;
    }
    out.gate = Gate::Ran;

    // --- run: organize, then compact, then (occasionally) observe. All
    // best-effort. ---
    match crate::organize::organize_once(polis).await {
        Ok(o) if o.ran => {
            out.organized = true;
            tracing::info!(summary = %o.summary, "gardener organized");
        }
        Ok(_) => {}
        Err(e) if e == crate::agent::NO_MODEL => out.no_model = true,
        Err(e) => tracing::warn!(error = %e, "gardener organize pass failed"),
    }
    match compaction_pass(polis).await {
        Ok(n) => {
            out.compacted = n;
            if n > 0 {
                tracing::info!(compacted = n, "gardener compacted cold prompts");
            }
        }
        Err(e) if e == crate::agent::NO_MODEL => out.no_model = true,
        Err(e) => tracing::warn!(error = %e, "gardener compaction pass failed"),
    }
    // Observation cadence: one pass per N organizes that actually ran
    // (counter persists across restarts).
    if out.organized {
        let n = polis
            .get_setting(OBSERVE_COUNTER_KEY)
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
            + 1;
        if n >= cfg.observe_every_n_organizes {
            match observations_pass(polis).await {
                Ok(k) => {
                    out.observed = k;
                    if k > 0 {
                        tracing::info!(observations = k, "gardener observed patterns");
                    }
                }
                Err(e) if e == crate::agent::NO_MODEL => out.no_model = true,
                Err(e) => tracing::warn!(error = %e, "gardener observation pass failed"),
            }
            let _ = polis.set_setting(OBSERVE_COUNTER_KEY, "0");
        } else {
            let _ = polis.set_setting(OBSERVE_COUNTER_KEY, &n.to_string());
        }
    }

    state.last_run_ms = Some(clock.now_ms());
    events.changed(&[Change::Memory, Change::Catalog, Change::Ledger]);
    out
}

#[cfg(test)]
mod step_tests {
    use super::*;
    use polis_core::host::NoHost;
    use polis_llm::NoopSink;
    use polis_store::record::{record_prompt_at, PromptInput};
    use polis_store::PolisStore;
    use std::sync::Mutex;

    struct FakeClock(Mutex<i64>);
    impl Clock for FakeClock {
        fn now_ms(&self) -> i64 {
            *self.0.lock().unwrap()
        }
    }
    struct Idle(i64);
    impl IdleSignal for Idle {
        fn last_activity_ms(&self) -> i64 {
            self.0
        }
    }
    struct Bus(Mutex<Vec<Change>>);
    impl GardenerEvents for Bus {
        fn changed(&self, what: &[Change]) {
            self.0.lock().unwrap().extend_from_slice(what);
        }
    }

    fn prompt(store: &PolisStore, body: &str, ts: i64) {
        record_prompt_at(
            store,
            PromptInput {
                source: polis_core::ledger::PromptSource::Hook,
                origin: polis_core::ledger::Origin::External,
                surface: "t".into(),
                role: polis_core::ledger::CorpusRole::User,
                session_id: None,
                claude_session_id: Some(body.to_string()),
                mission_id: None,
                project_path: None,
                body: body.to_string(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
                user_text: None,
            },
            ts,
        )
        .unwrap();
    }

    /// The gates in order, with no model: nothing new → busy → ran (the
    /// no-model state reported, nothing errored, events fired) → debounced.
    #[tokio::test]
    async fn the_gates_hold_and_a_run_without_a_model_reports_no_model() {
        let store = PolisStore::open_in_memory().unwrap();
        let polis = Polis::new(&store, None, &NoHost, &NoopSink);
        let clock = FakeClock(Mutex::new(1_000_000));
        let bus = Bus(Mutex::new(Vec::new()));
        let cfg = GardenerConfig::default();
        let mut st = GardenerState::default();

        let o = step(&polis, &mut st, &Idle(0), &clock, &cfg, &bus).await;
        assert_eq!(o.gate, Gate::NothingNew, "an empty lake has nothing to organize");

        let seeded_at = clock.now_ms();
        for i in 0..30 {
            prompt(&store, &format!("prompt {i}"), seeded_at);
        }
        *clock.0.lock().unwrap() += 200_000; // past the idle window since the newest event
        let busy = step(&polis, &mut st, &Idle(clock.now_ms() - 1_000), &clock, &cfg, &bus).await;
        assert_eq!(busy.gate, Gate::Busy, "a terminal that just produced output parks the passes");

        let ran = step(&polis, &mut st, &Idle(0), &clock, &cfg, &bus).await;
        assert_eq!(ran.gate, Gate::Ran);
        assert!(ran.no_model, "no agent → the model passes report no_model, never an error");
        assert!(!ran.organized);
        assert_eq!(ran.compacted, 0);
        assert!(bus.0.lock().unwrap().contains(&Change::Catalog), "a run announces itself");
        assert!(store.verify_ledger_chain().unwrap().ok);

        let again = step(&polis, &mut st, &Idle(0), &clock, &cfg, &bus).await;
        assert_eq!(again.gate, Gate::Debounced);
    }
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
            (2, 100, "user".into(), Some("b".into())),
            (1, 500, "user".into(), Some("a".into())),
            (1, 500, "user".into(), Some("b".into())),
            // Machine text arrives with no class link at all — it is kept out of
            // the classifier, so it can only ever go cold on age.
            (3, 900, "agent".into(), None),
        ];
        let g = group_candidates(rows);
        assert_eq!(g.len(), 3);
        assert_eq!(g[0].prompt_id, 1); // sorted
        assert_eq!(g[0].node_ids.len(), 2); // a + b folded
        assert_eq!(g[1].prompt_id, 2);
        assert_eq!(g[2].role, "agent");
        assert!(g[2].node_ids.is_empty(), "a NULL node_id folds to no link");
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
            // cold + big + unprotected + machine → picked
            PromptCand { prompt_id: 1, bytes: 5000, role: "agent".into(), node_ids: vec!["cold".into()] },
            // too small → skipped
            PromptCand { prompt_id: 2, bytes: 100, role: "agent".into(), node_ids: vec!["cold".into()] },
            // not cold → skipped
            PromptCand { prompt_id: 3, bytes: 5000, role: "agent".into(), node_ids: vec!["warm".into()] },
            // pinned/protected → skipped even though cold+big
            PromptCand {
                prompt_id: 4,
                bytes: 5000,
                role: "agent".into(),
                node_ids: vec!["cold".into(), "pinned".into()],
            },
            // unlinked machine text → picked (the SQL already applied the age
            // gate; with no class link there is no node to be cold through)
            PromptCand { prompt_id: 5, bytes: 5000, role: "system".into(), node_ids: vec![] },
        ];
        let cold: HashSet<String> = ["cold".to_string()].into_iter().collect();
        let protected: HashSet<String> = ["pinned".to_string()].into_iter().collect();
        let picked = select_compaction_candidates(&cands, &cold, &protected, SIZE_FLOOR_BYTES);
        assert_eq!(picked, vec![1, 5]);
    }

    /// The blade never points at the user's own words. Compaction had been
    /// running as a garbage collector for the capture leak (~207 of 224
    /// compacted rows were machine text), which made a 59:1 irrecoverable
    /// release look like a success while the same mechanism was pointed at
    /// prompts the user actually typed. A `user` row leaves only by an explicit
    /// `memory_forget`.
    #[test]
    fn select_never_compacts_the_users_own_words() {
        let cands = vec![
            // Everything about this row says "compact me" except its role.
            PromptCand { prompt_id: 1, bytes: 50_000, role: "user".into(), node_ids: vec!["cold".into()] },
            // A NULL role reads as `user` upstream (COALESCE) and is equally safe.
            PromptCand { prompt_id: 2, bytes: 50_000, role: "user".into(), node_ids: vec![] },
            PromptCand { prompt_id: 3, bytes: 50_000, role: "agent".into(), node_ids: vec!["cold".into()] },
        ];
        let cold: HashSet<String> = ["cold".to_string()].into_iter().collect();
        let picked =
            select_compaction_candidates(&cands, &cold, &HashSet::new(), SIZE_FLOOR_BYTES);
        assert_eq!(picked, vec![3], "only machine text is an automatic target");
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
        let stat = |count: i64, ts: i64| polis_core::coldness::BranchStat {
            last_ts: Some(ts),
            item_count: count,
            pinned: false,
        };
        let stats: HashMap<String, polis_core::coldness::BranchStat> = [
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
}
