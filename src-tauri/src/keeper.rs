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
//!
//! **The watch bus — crons watch, models act.** The keeper's 30s loop is also
//! the app's one background scheduler: a registry of named watches
//! (`WATCHES`), each `{name, predicate, gate, target_role, cadence}`, driven
//! by a due-cadence check on every tick, plus `schedule_once` for event-armed
//! one-shots. A watch only ever *notices* a condition and wakes an existing
//! actor or spawn site — the bus itself spawns no agents and lands no work.
//! The ad hoc timers that used to run as their own threads/tasks are re-homed
//! here (mirror sync, ledger backup, the orchestrate-stall sweep, the revise
//! watchdog's scheduling, the review-staleness sweep), and the ready-depth
//! watch nudges the overnight queue's existing ignition when opted-in work
//! piles up while the machine is idle. New background behavior becomes a bus
//! entry, not a new thread — **the bus is the one scheduling vocabulary going
//! forward**. The memory passes (organize / compaction / observations) remain
//! the loop's own body, running beside the bus under their idle / growth /
//! debounce gates exactly as before.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::classmem::{self, auto_collapse_safe, subtree_stats, ClassNode};
use crate::claude_proc::{classify_line, resolve_claude_bin, StreamLine};
use crate::db::Database;
use crate::ledger::{self, now_millis};
use crate::state::{AttachState, SessionStatus, SessionStore};

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
/// Deterministic-fallback gist keeps this many leading characters…
const GIST_HEAD_CHARS: usize = 200;
/// …and this many trailing ones. A prompt states its ask at the top and lands
/// its decision at the bottom; a pure head window keeps the first and throws the
/// second away, which is why 47% of surviving gists read as an opening sentence
/// and nothing else. Head+tail costs 80 characters and keeps both ends.
const GIST_TAIL_CHARS: usize = 120;
/// How long a machine-authored row (`agent`/`system`) stays warm. Measured in
/// lake time against the newest event, like every other coldness here — never
/// wall clock. Machine text has no class link to go cold *through*, so age is
/// the only signal it has; a week is long enough that anything still on screen
/// is untouched.
const MACHINE_COLD_MS: i64 = 7 * 24 * 3600 * 1000;
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

// ---------------------------------------------------------------------------
// Gist generation — tiered (agent summarizer, deterministic fallback)
// ---------------------------------------------------------------------------

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

/// Deterministic gist for when the agent summarizer is unavailable or its reply
/// won't parse — compaction must never hard-depend on `claude` being installed.
/// Keeps `GIST_HEAD_CHARS` from the front AND `GIST_TAIL_CHARS` from the back,
/// and records what was released: the ask is at the top, the decision is at the
/// bottom, and a head-only window silently kept one and destroyed the other.
/// Short bodies collapse to a single window with no ellipsis in the middle.
pub fn deterministic_gist(body: &str) -> String {
    let bytes = body.len();
    let flat: Vec<char> = body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .collect();
    let summary = if flat.len() <= GIST_HEAD_CHARS + GIST_TAIL_CHARS {
        flat.iter().collect::<String>()
    } else {
        let head: String = flat[..GIST_HEAD_CHARS].iter().collect();
        let tail: String = flat[flat.len() - GIST_TAIL_CHARS..].iter().collect();
        format!("{head} … {tail}")
    };
    format!("{summary}… [compacted {bytes} bytes]")
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
    ledger::register_agent_prompt(&prompt);
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
    match run_keeper_summarizer(&cwd, build_keeper_prompt(&bodies)).await {
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
// The watch bus — crons watch, models act
// ---------------------------------------------------------------------------

/// Everything a watch may look at or act through — the same few app handles
/// the old ad hoc timers each closed over individually, gathered once.
pub(crate) struct WatchCtx {
    pub(crate) app: AppHandle,
    pub(crate) db: Arc<Database>,
    pub(crate) store: SessionStore,
    /// The live held-POST map — the staleness sweep's ground truth for
    /// "does this session actually hold a sender right now".
    pub(crate) pending: crate::PendingResponses,
    /// App data dir — the backup watch snapshots into `<data_dir>/backups`.
    pub(crate) data_dir: PathBuf,
}

/// One registry entry: `{name, predicate, gate, target_role, cadence}`. New
/// watches become entries here, never threads.
pub(crate) struct Watch {
    pub(crate) name: &'static str,
    /// Who acts when this watch fires — the actor the wake is *for*. The bus
    /// never spawns an agent itself; it wakes `target_role`'s existing seam.
    pub(crate) target_role: &'static str,
    /// How often the bus evaluates this watch (a due-cadence check per 30s
    /// tick). The check is stamped whether or not the watch fires, so a gated
    /// or false predicate re-evaluates one cadence later, not one tick later.
    pub(crate) cadence: Duration,
    /// Cheap veto checked before the predicate (config / idle gates).
    pub(crate) gate: fn(&WatchCtx, i64) -> bool,
    /// The condition being watched.
    pub(crate) predicate: fn(&WatchCtx, i64) -> bool,
    /// Wake the actor. Must not stall the loop: blocking work goes through
    /// the house `spawn_blocking` pattern; anything long-lived is an EXISTING
    /// spawn site being woken, never a new one.
    pub(crate) act: fn(&WatchCtx, i64),
}

/// Mirror-sync cadence — the 120s rhythm of the retired `std::thread` loop.
const MIRROR_SYNC_EVERY: Duration = Duration::from_secs(120);
/// Ledger-backup cadence — the 6h rhythm of the retired `std::thread` loop.
/// The immediate startup snapshot stays at the setup site.
const BACKUP_EVERY: Duration = Duration::from_secs(6 * 3600);
/// Orchestrate-stall sweep cadence. The stall *window* itself stays
/// `crate::ORCHESTRATE_STALL_WINDOW` (queue.rs consumes it from lib.rs);
/// sweeping every minute detects a stall at most a minute late.
const STALL_SWEEP_EVERY: Duration = Duration::from_secs(60);
/// Review-staleness sweep cadence — deliberately conservative. With the
/// seen-twice rule a session reconciles 5–10 minutes after its held POST
/// silently died, never on a single racy observation.
const STALENESS_SWEEP_EVERY: Duration = Duration::from_secs(5 * 60);
/// Ready-depth cadence: how often the hub even considers nudging the queue.
const READY_DEPTH_SWEEP_EVERY: Duration = Duration::from_secs(5 * 60);
/// The documented ready-depth threshold: the unfiltered ready-work frontier
/// (`db::list_ready_work_items`, no project filter) must hold at least this
/// many items before the overnight queue is nudged.
pub(crate) const READY_DEPTH_THRESHOLD: usize = 3;
/// Friction-filer cadence — deliberately conservative: recurring friction is
/// a slow signal, so the bus considers filing at most every 6 hours.
const FRICTION_FILE_EVERY: Duration = Duration::from_secs(6 * 3600);
/// How often the semantic index catches up. Two minutes: frequent enough that
/// a page you just read is searchable within a coffee refill, rare enough that
/// an idle machine isn't running inference on a loop.
const EMBED_INDEX_EVERY: Duration = Duration::from_secs(120);
/// The documented friction threshold: a friction kind files ONE work item
/// only once it has fired at least this many times inside the window.
pub(crate) const FRICTION_FILE_THRESHOLD: i64 = 5;
/// The window `friction_summary` aggregates over for the filer: 7 days —
/// wide enough that "recurring" means a pattern, not one bad afternoon.
const FRICTION_WINDOW_MS: i64 = 7 * 24 * 3600 * 1000;
/// Settings-key prefix for the per-kind high-water marks (the house
/// app_settings pattern, one key per friction kind).
const FRICTION_MARK_PREFIX: &str = "redline.frictionWatch.highWater.";

/// Due-cadence bookkeeping (pure): `None` = never checked → due now.
pub fn cadence_due(last_run_ms: Option<i64>, cadence_ms: i64, now_ms: i64) -> bool {
    last_run_ms.map_or(true, |l| now_ms - l >= cadence_ms)
}

/// The trivial gate/predicate for pure cadence watches.
fn always(_ctx: &WatchCtx, _now: i64) -> bool {
    true
}

// --- mirror sync (was a 120s std::thread in lib.rs) -------------------------

/// Blocking filesystem work rides `spawn_blocking` so a slow disk never
/// stalls the bus tick. `sync_if_enabled` is a no-op until a dir is set.
fn mirror_act(ctx: &WatchCtx, _now: i64) {
    let db = ctx.db.clone();
    tokio::task::spawn_blocking(move || {
        crate::mirror::sync_if_enabled(&db);
    });
}

// --- ledger backup (was a 6h std::thread in lib.rs) -------------------------

fn backup_act(ctx: &WatchCtx, _now: i64) {
    let db = ctx.db.clone();
    let dir = ctx.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        crate::snapshot_database(&db, &dir, crate::LEDGER_BACKUP_KEEP);
        // The DEEP chain check, and the reason the memory pill can afford a
        // cheap one. `verify_ledger_chain_incremental` re-walks only what grew
        // since its stored anchor, so it cannot see a retroactive edit to a
        // row it already verified; this full re-hash can, and runs on the same
        // 6h cadence as the backup it validates. Already off the main thread —
        // it rides the backup's `spawn_blocking`.
        match db.verify_ledger_chain() {
            Ok(v) if v.ok => {
                tracing::info!(checked = v.checked, "ledger chain verified (deep walk)")
            }
            Ok(v) => tracing::error!(
                first_bad_seq = ?v.first_bad_seq,
                checked = v.checked,
                "LEDGER CHAIN VERIFICATION FAILED — the record may have been tampered with"
            ),
            Err(e) => tracing::warn!(error = %e, "deep ledger verify could not run"),
        }
    });
}

// --- orchestrate-stall sweep ------------------------------------------------

/// When each session was FIRST observed in `orchestrating` by this process.
/// In-memory on purpose: `run_updated_at` isn't surfaced by a db helper, and
/// a restart merely restarts the clock — detection after a relaunch is at
/// most one window late, still strictly better than the old one-shot task,
/// which died with its process and then never fired at all.
fn stall_first_seen() -> &'static StdMutex<HashMap<String, i64>> {
    static G: OnceLock<StdMutex<HashMap<String, i64>>> = OnceLock::new();
    G.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// One sweep step (pure over the passed map): drop sessions no longer
/// orchestrating (a beacon landed — their clock resets if they ever return),
/// start the clock for newly-seen ones, and return the sessions that have sat
/// in `orchestrating` for at least `window_ms`. Sorted for determinism.
pub fn stall_sweep_mark(
    first_seen: &mut HashMap<String, i64>,
    orchestrating: &[String],
    now_ms: i64,
    window_ms: i64,
) -> Vec<String> {
    first_seen.retain(|sid, _| orchestrating.iter().any(|o| o == sid));
    for sid in orchestrating {
        first_seen.entry(sid.clone()).or_insert(now_ms);
    }
    let mut ripe: Vec<String> = first_seen
        .iter()
        .filter(|(_, &t)| now_ms - t >= window_ms)
        .map(|(s, _)| s.clone())
        .collect();
    ripe.sort();
    ripe
}

fn orchestrating_sessions(ctx: &WatchCtx) -> Vec<String> {
    ctx.store
        .list()
        .into_iter()
        .filter(|s| s.run_state.as_deref() == Some("orchestrating"))
        .map(|s| s.session_id)
        .collect()
}

/// Something is (or was just) on the clock — the sweep must also run when the
/// tracked set needs clearing, so a session that left `orchestrating` between
/// sweeps drops its stale clock instead of firing instantly on a later return.
fn stall_watch_predicate(ctx: &WatchCtx, _now: i64) -> bool {
    !orchestrating_sessions(ctx).is_empty() || !stall_first_seen().lock().unwrap().is_empty()
}

/// Walk every over-window `orchestrating` session to `stalled` — the periodic,
/// restart-surviving form of the one-shot `arm_orchestrate_stall_watchdog`
/// (which stays at its call sites as cheap belt-and-braces). Re-checks
/// `orchestrate_stall_should_fire` right before walking, so the sweep only
/// ever stalls a chip still reading `orchestrating`.
fn stall_watch_act(ctx: &WatchCtx, now: i64) {
    let window_ms = crate::ORCHESTRATE_STALL_WINDOW.as_millis() as i64;
    let orch = orchestrating_sessions(ctx);
    let ripe = {
        let mut seen = stall_first_seen().lock().unwrap();
        stall_sweep_mark(&mut seen, &orch, now, window_ms)
    };
    if ripe.is_empty() {
        return;
    }
    // The per-session sqlite read + run-state walk ride `spawn_blocking`
    // (the house pattern — see `mirror_act`) so the bus tick never blocks
    // on the database.
    let app = ctx.app.clone();
    let store = ctx.store.clone();
    tokio::task::spawn_blocking(move || {
        for sid in ripe {
            let state = store.database().get_run_state(&sid);
            if crate::orchestrate_stall_should_fire(state.as_deref()) {
                tracing::info!(session_id = %sid, "orchestrate stall sweep fired");
                crate::advance_run_state(&app, &store, &sid, "stalled");
            }
        }
    });
}

// --- abandoned-run sweep ----------------------------------------------------

/// How often the abandoned-run sweep evaluates. Cheap (one in-memory
/// `store.list()` plus, only when something is ripe, one link lookup per held
/// review), and the window it enforces is a day — a slow cadence is fine.
const ABANDONED_RUN_SWEEP_EVERY: Duration = Duration::from_secs(30 * 60);

/// Sessions whose chip is in a state the sweep may touch, with the timestamp
/// the window is measured from. `updated_at` is the session's last activity of
/// ANY kind, which is exactly the "nothing has happened here" signal wanted.
fn abandoned_run_candidates(ctx: &WatchCtx) -> Vec<(String, i64, Option<String>)> {
    ctx.store
        .list()
        .into_iter()
        .filter(|s| {
            s.run_state
                .as_deref()
                .is_some_and(|r| crate::ABANDONED_RUN_STATES.contains(&r))
        })
        .map(|s| (s.session_id, s.updated_at, s.run_state))
        .collect()
}

fn abandoned_run_predicate(ctx: &WatchCtx, _now: i64) -> bool {
    !abandoned_run_candidates(ctx).is_empty()
}

/// Walk every run that claimed work and then went silent for a day to
/// `stalled` — unless a human is demonstrably still holding it.
fn abandoned_run_act(ctx: &WatchCtx, now: i64) {
    let candidates = abandoned_run_candidates(ctx);
    if candidates.is_empty() {
        return;
    }
    let window_ms = crate::ABANDONED_RUN_WINDOW.as_millis() as i64;
    // Every plan session a currently-held code review closes out. Resolved
    // through the T4.1 chain, so a review held across a restart still vetoes.
    let live_links: HashSet<String> = ctx
        .app
        .try_state::<crate::PendingReviews>()
        .map(|pr| pr.held_ids())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|rid| crate::orchestration_review_link(&ctx.db, &rid))
        .collect();

    // The run-state walk rides `spawn_blocking` (the house pattern — see
    // `mirror_act`) so the bus tick never blocks on the database.
    let app = ctx.app.clone();
    let store = ctx.store.clone();
    let pending = ctx.pending.clone();
    tokio::task::spawn_blocking(move || {
        for (sid, updated_at, run_state) in candidates {
            if !crate::abandoned_run_should_stall(
                run_state.as_deref(),
                now - updated_at,
                window_ms,
                pending.has(&sid),
                live_links.contains(&sid),
            ) {
                continue;
            }
            let idle_h = (now - updated_at) / 3_600_000;
            tracing::info!(
                session_id = %sid,
                run_state = ?run_state,
                idle_hours = idle_h,
                "abandoned-run sweep: walking a silent run to stalled"
            );
            crate::db::note_friction(
                "run_stalled",
                Some("orchestration"),
                Some(&sid),
                Some(&format!(
                    "{} for {idle_h}h with no beacon",
                    run_state.as_deref().unwrap_or("?")
                )),
            );
            crate::advance_run_state(&app, &store, &sid, "stalled");
        }
    });
}

// --- review-staleness sweep -------------------------------------------------

/// Suspects from the previous sweep: sessions observed once with a persisted
/// `Held` attach state but no live held POST. In-memory — the seen-twice rule
/// is a race guard, not durable state (the startup held→detached sweep in
/// `SessionStore::new` already covers restarts).
fn staleness_seen() -> &'static StdMutex<HashSet<String>> {
    static G: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    G.get_or_init(|| StdMutex::new(HashSet::new()))
}

/// Seen-twice reconciliation step (pure): only a session suspect on TWO
/// consecutive sweeps is detached — one observation can race the tiny window
/// between a plan POST's attach-state write and its sender registration.
/// Returns (sessions to detach now, the suspect set to carry forward).
pub fn staleness_step(
    prev_suspects: &HashSet<String>,
    current: &HashSet<String>,
) -> (Vec<String>, HashSet<String>) {
    let mut to_detach: Vec<String> = current.intersection(prev_suspects).cloned().collect();
    to_detach.sort();
    let next: HashSet<String> = current
        .iter()
        .filter(|s| !to_detach.contains(s))
        .cloned()
        .collect();
    (to_detach, next)
}

/// A staleness candidate: still `InReview`, persisted attach state `Held`,
/// but no live held POST — the inconsistency `mark_session_detached` exists
/// to reconcile, found by sweep instead of waiting for a user action to trip
/// over it.
fn staleness_candidates(ctx: &WatchCtx) -> HashSet<String> {
    ctx.store
        .list()
        .into_iter()
        .filter(|s| matches!(s.status, SessionStatus::InReview))
        .filter(|s| s.attach_state == AttachState::Held)
        .filter(|s| !ctx.pending.has(&s.session_id))
        .map(|s| s.session_id)
        .collect()
}

/// Runs when there is a candidate OR a carried suspect (the latter so a
/// resolved suspect is forgotten rather than detached on a much-later blip).
fn staleness_predicate(ctx: &WatchCtx, _now: i64) -> bool {
    !staleness_candidates(ctx).is_empty() || !staleness_seen().lock().unwrap().is_empty()
}

fn staleness_act(ctx: &WatchCtx, _now: i64) {
    let current = staleness_candidates(ctx);
    let to_detach = {
        let mut seen = staleness_seen().lock().unwrap();
        let (to_detach, next) = staleness_step(&seen, &current);
        *seen = next;
        to_detach
    };
    if to_detach.is_empty() {
        return;
    }
    // The detach reconciliation writes sqlite — off the tick via the house
    // `spawn_blocking` pattern (see `mirror_act`).
    let app = ctx.app.clone();
    let store = ctx.store.clone();
    tokio::task::spawn_blocking(move || {
        for sid in to_detach {
            tracing::warn!(
                session_id = %sid,
                "staleness sweep: held attach state with no held POST on two \
                 consecutive sweeps — reconciling to detached"
            );
            crate::mark_session_detached(&app, &store, &sid);
        }
    });
}

// --- ready-depth (the hub becomes continuous) -------------------------------

/// The ready-depth gate (pure half): the overnight queue config is ENABLED
/// (explicit user opt-in — repos allow-listed) AND the machine is idle. If
/// the queue is not enabled this watch NEVER fires.
pub fn queue_gate_open(queue_enabled: bool, idle: bool) -> bool {
    queue_enabled && idle
}

/// The ready-depth predicate (pure half): frontier depth at-or-over the
/// documented threshold.
pub fn ready_over_threshold(count: usize, threshold: usize) -> bool {
    count >= threshold
}

/// The composed ready-depth decision — exactly what the bus evaluates as
/// gate && predicate, kept whole and pure for the tests.
pub fn ready_depth_should_fire(
    queue_enabled: bool,
    idle: bool,
    ready_count: usize,
    threshold: usize,
) -> bool {
    queue_gate_open(queue_enabled, idle) && ready_over_threshold(ready_count, threshold)
}

/// The gate halves, read fresh: (queue enabled by explicit opt-in, machine
/// idle by the keeper's own idle rule).
fn ready_gate_halves(ctx: &WatchCtx, now: i64) -> (bool, bool) {
    let enabled = !crate::queue::load_config(&ctx.db).repos.is_empty();
    let lake_newest = ctx.db.lake_envelope().map(|e| e.newest).unwrap_or(0);
    let idle = is_idle(crate::pty::last_pty_output_ms(), lake_newest, now, IDLE_WINDOW_MS);
    (enabled, idle)
}

/// Cheap veto: skips the frontier query entirely while gated off.
fn ready_watch_gate(ctx: &WatchCtx, now: i64) -> bool {
    let (enabled, idle) = ready_gate_halves(ctx, now);
    queue_gate_open(enabled, idle)
}

/// Evaluates the WHOLE composed decision (`ready_depth_should_fire`), gate
/// halves re-read included — belt and braces, and the pure seam the tests
/// pin stays the one place the semantics live.
fn ready_watch_predicate(ctx: &WatchCtx, now: i64) -> bool {
    let (enabled, idle) = ready_gate_halves(ctx, now);
    let depth = ctx
        .db
        .list_ready_work_items(None, now, READY_DEPTH_THRESHOLD as i64)
        .map(|v| v.len())
        .unwrap_or(0);
    ready_depth_should_fire(enabled, idle, depth, READY_DEPTH_THRESHOLD)
}

/// The watch wakes an existing spawn site (the queue's own ignition, via its
/// nudge seam); it spawns nothing itself.
fn ready_watch_act(ctx: &WatchCtx, _now: i64) {
    tracing::info!("ready-depth watch: frontier at threshold — nudging the overnight queue");
    crate::queue::nudge(&ctx.app);
}

// --- friction filer (producers wave) ----------------------------------------

fn friction_mark_key(kind: &str) -> String {
    format!("{FRICTION_MARK_PREFIX}{kind}")
}

/// The friction-filer's pure step: given the windowed per-kind counts and the
/// stored per-kind high-water marks, return `(kinds to file now, marks to
/// LOWER)`. A kind files when its count is at-or-over the threshold AND above
/// its mark — i.e. it *crossed* since the last filing; a mark lowers when the
/// sliding window fell under it, so a genuine later re-surge can cross again
/// instead of being blocked forever by a stale peak.
pub fn friction_step(
    counts: &[(String, i64)],
    marks: &HashMap<String, i64>,
    threshold: i64,
) -> (Vec<(String, i64)>, Vec<(String, i64)>) {
    let mut to_file = Vec::new();
    let mut to_lower = Vec::new();
    for (kind, count) in counts {
        let mark = marks.get(kind).copied().unwrap_or(0);
        if *count >= threshold && *count > mark {
            to_file.push((kind.clone(), *count));
        } else if *count < mark {
            to_lower.push((kind.clone(), *count));
        }
    }
    (to_file, to_lower)
}

/// The stored high-water mark for each kind in `counts` (missing / unparsable
/// keys read as 0).
fn friction_marks(db: &Database, counts: &[(String, i64)]) -> HashMap<String, i64> {
    counts
        .iter()
        .map(|(kind, _)| {
            let mark = db
                .get_setting(&friction_mark_key(kind))
                .and_then(|s| s.trim().parse::<i64>().ok())
                .unwrap_or(0);
            (kind.clone(), mark)
        })
        .collect()
}

/// One friction-filer pass (producers wave): read the summary window, apply
/// [`friction_step`], file ONE `bug` work item per crossing kind —
/// `origin_kind="friction"` / `origin_id=<kind>`, provenance never ownership
/// — advance the crossed kinds' marks, lower decayed ones, and credit the
/// keeper seat's `items_filed`. A kind with an UNCLOSED friction item still
/// standing never files a second (the belt on top of the marks); its mark
/// still advances so the watch goes quiet. The act FILES STATE ONLY — it
/// spawns nothing, wakes nothing, dispatches nothing.
pub(crate) fn file_friction_items(db: &Database, window_ms: i64, threshold: i64) -> usize {
    /// Ledger actor + the seat whose `items_filed` accrues.
    const FRICTION_ACTOR: &str = "keeper";
    let rows = match db.friction_summary(window_ms) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "friction summary failed; nothing filed");
            return 0;
        }
    };
    let counts: Vec<(String, i64)> = rows.iter().map(|r| (r.kind.clone(), r.count)).collect();
    let marks = friction_marks(db, &counts);
    let (to_file, to_lower) = friction_step(&counts, &marks, threshold);
    for (kind, count) in &to_lower {
        let _ = db.set_setting(&friction_mark_key(kind), &count.to_string());
    }
    let mut filed = 0usize;
    for (kind, count) in &to_file {
        match db.find_unclosed_work_item("friction", Some(kind), None) {
            Ok(Some(_)) => {
                // One standing item per kind — the mark still advances so the
                // predicate goes quiet until the count crosses again.
                let _ = db.set_setting(&friction_mark_key(kind), &count.to_string());
                continue;
            }
            Ok(None) => {}
            Err(e) => {
                // Without the idempotency answer, filing could duplicate —
                // SKIP this kind (the watch re-derives next pass). The mark
                // does NOT advance, so the crossing stays visible.
                tracing::warn!(kind = %kind, error = %e, "friction idempotency lookup failed; nothing filed");
                continue;
            }
        }
        let days = (window_ms / 86_400_000).max(1);
        let title = format!("Recurring friction: {kind} ({count}× in {days}d)");
        let mut body = format!(
            "The `{kind}` friction event fired {count} times in the last \
             {days} days (files at {threshold})."
        );
        if let Some(detail) = rows
            .iter()
            .find(|r| r.kind == *kind)
            .and_then(|r| r.last_detail.as_deref())
        {
            body.push_str(&format!("\n\nMost recent detail:\n{detail}"));
        }
        match db.file_produced_work_item(
            &title,
            Some(&body),
            "bug",
            "open",
            2,
            "friction",
            Some(kind),
            None,
            None,
            FRICTION_ACTOR,
        ) {
            Ok(Some(_)) => {
                filed += 1;
                let _ = db.set_setting(&friction_mark_key(kind), &count.to_string());
            }
            Ok(None) => {
                let _ = db.set_setting(&friction_mark_key(kind), &count.to_string());
            }
            // A failed write does NOT advance the mark — the next pass retries.
            Err(e) => tracing::warn!(
                kind = %kind, error = %e,
                "failed to file a friction work item"
            ),
        }
    }
    if filed > 0 {
        if let Err(e) = db.upsert_seat_stat(FRICTION_ACTOR, None, filed as i64) {
            tracing::warn!(error = %e, "failed to bump keeper items_filed");
        }
    }
    filed
}

/// Fires when a kind crossed OR a decayed mark needs lowering — the latter is
/// the bookkeeping half, mirroring the stall sweep's "the tracked set needs
/// clearing" rule so marks don't stay stale behind an inactive frontier.
fn friction_watch_predicate(ctx: &WatchCtx, _now: i64) -> bool {
    let rows = match ctx.db.friction_summary(FRICTION_WINDOW_MS) {
        Ok(rows) => rows,
        Err(_) => return false,
    };
    let counts: Vec<(String, i64)> = rows.iter().map(|r| (r.kind.clone(), r.count)).collect();
    let marks = friction_marks(&ctx.db, &counts);
    let (to_file, to_lower) = friction_step(&counts, &marks, FRICTION_FILE_THRESHOLD);
    !to_file.is_empty() || !to_lower.is_empty()
}

/// The act files state — it spawns nothing. Off the loop via the house
/// `spawn_blocking` pattern so a slow disk never stalls the bus tick.
fn friction_watch_act(ctx: &WatchCtx, _now: i64) {
    let db = ctx.db.clone();
    tokio::task::spawn_blocking(move || {
        let filed = file_friction_items(&db, FRICTION_WINDOW_MS, FRICTION_FILE_THRESHOLD);
        if filed > 0 {
            tracing::info!(filed, "friction watch filed recurring-friction work items");
        }
    });
}

/// The registry — the bus's whole schedule, one table.
pub(crate) static WATCHES: &[Watch] = &[
    Watch {
        name: "mirror-sync",
        target_role: "mirror",
        cadence: MIRROR_SYNC_EVERY,
        gate: always,
        predicate: always,
        act: mirror_act,
    },
    Watch {
        name: "ledger-backup",
        target_role: "backup",
        cadence: BACKUP_EVERY,
        gate: always,
        predicate: always,
        act: backup_act,
    },
    Watch {
        name: "orchestrate-stall-sweep",
        target_role: "orchestrator",
        cadence: STALL_SWEEP_EVERY,
        gate: always,
        predicate: stall_watch_predicate,
        act: stall_watch_act,
    },
    Watch {
        name: "abandoned-run-sweep",
        target_role: "orchestrator",
        cadence: ABANDONED_RUN_SWEEP_EVERY,
        gate: always,
        predicate: abandoned_run_predicate,
        act: abandoned_run_act,
    },
    Watch {
        name: "review-staleness-sweep",
        target_role: "reviewer",
        cadence: STALENESS_SWEEP_EVERY,
        gate: always,
        predicate: staleness_predicate,
        act: staleness_act,
    },
    Watch {
        name: "ready-depth",
        target_role: "orchestrator",
        cadence: READY_DEPTH_SWEEP_EVERY,
        gate: ready_watch_gate,
        predicate: ready_watch_predicate,
        act: ready_watch_act,
    },
    Watch {
        name: "friction-filer",
        target_role: "keeper",
        cadence: FRICTION_FILE_EVERY,
        gate: always,
        predicate: friction_watch_predicate,
        act: friction_watch_act,
    },
    Watch {
        name: "shots-retention",
        target_role: "keeper",
        cadence: SHOTS_SWEEP_EVERY,
        gate: always,
        predicate: always,
        act: shots_sweep_act,
    },
    Watch {
        name: "embedding-index",
        target_role: "keeper",
        cadence: EMBED_INDEX_EVERY,
        // IDLE-gated. Inference is the one background job here that competes
        // for the Neural Engine and the CPU with whatever the user is doing;
        // a retrieval index is never worth a stutter in the thing being
        // indexed. It converges over quiet minutes instead.
        gate: embed_watch_gate,
        predicate: embed_watch_predicate,
        act: embed_watch_act,
    },
];

// --- the picture store's retention (Phase 7) -------------------------------

/// A bus entry, not a new timer — the bus is the one scheduling vocabulary.
const SHOTS_SWEEP_EVERY: Duration = Duration::from_secs(6 * 3600);

fn shots_sweep_act(ctx: &WatchCtx, _now: i64) {
    let db = ctx.db.clone();
    let app = ctx.app.clone();
    tokio::task::spawn_blocking(move || {
        let removed = crate::shots::sweep(&app, &db);
        if removed > 0 {
            tracing::info!(removed, "swept unreferenced/aged page shots");
        }
    });
}

// --- semantic index (Phase 6) ----------------------------------------------

/// Targets embedded per tick. Bounded so a cold start spreads over minutes
/// rather than pinning a core: the index is allowed to be late, never heavy.
const EMBED_BATCH: usize = 16;

fn embed_watch_gate(ctx: &WatchCtx, now: i64) -> bool {
    if crate::embed::provider_for(&ctx.db).is_none() {
        return false;
    }
    let lake_newest = ctx.db.lake_envelope().map(|e| e.newest).unwrap_or(0);
    is_idle(crate::pty::last_pty_output_ms(), lake_newest, now, IDLE_WINDOW_MS)
}

/// Cheap: one COUNT against the same predicate the worker uses, so the watch
/// never wakes a worker that would find nothing to do.
fn embed_watch_predicate(ctx: &WatchCtx, _now: i64) -> bool {
    let Some(p) = crate::embed::provider_for(&ctx.db) else { return false };
    ctx.db
        .embedding_stats(&p.model_id())
        .map(|(_, pending)| pending > 0)
        .unwrap_or(false)
}

fn embed_watch_act(ctx: &WatchCtx, _now: i64) {
    let db = ctx.db.clone();
    let app = ctx.app.clone();
    tokio::task::spawn_blocking(move || {
        let done = crate::embed::index_tick(&db, EMBED_BATCH);
        if done > 0 {
            tracing::info!(targets = done, "embedded a batch for the semantic arm");
            // Health shows `pending`; a batch that lands should move it.
            let _ = app.emit("memory-changed", ());
        }
    });
}

/// One bus pass: for each due watch, stamp the check, then gate → predicate
/// → act. `last` maps watch name → last check stamp.
fn run_bus(last: &mut HashMap<&'static str, i64>, ctx: &WatchCtx, now: i64) {
    for w in WATCHES {
        if !cadence_due(last.get(w.name).copied(), w.cadence.as_millis() as i64, now) {
            continue;
        }
        last.insert(w.name, now);
        if !(w.gate)(ctx, now) || !(w.predicate)(ctx, now) {
            continue;
        }
        tracing::debug!(watch = w.name, target_role = w.target_role, "watch fired");
        (w.act)(ctx, now);
    }
}

// --- scheduled one-shots (`schedule_once`) ----------------------------------

pub(crate) type OneShotFut = Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// One event-armed, scheduled task — fired exactly once by the bus at the
/// first tick at-or-after its due time, then gone.
pub(crate) struct OneShot {
    pub(crate) name: String,
    pub(crate) due_ms: i64,
    pub(crate) task: Box<dyn FnOnce() -> OneShotFut + Send>,
}

fn oneshot_queue() -> &'static StdMutex<Vec<OneShot>> {
    static G: OnceLock<StdMutex<Vec<OneShot>>> = OnceLock::new();
    G.get_or_init(|| StdMutex::new(Vec::new()))
}

/// Schedule an event-armed one-shot on the bus. NOT periodic: it fires once,
/// at the first 30s tick at-or-after `delay` elapses (the tick quantizes the
/// delay upward by at most one `TICK`). Re-arming is the caller's move —
/// schedule again from inside the task. Duplicate names are allowed on
/// purpose: supersession is the caller's concern (e.g. the revise watchdog's
/// generation counter).
pub(crate) fn schedule_once<F>(name: impl Into<String>, delay: Duration, task: F)
where
    F: FnOnce() -> OneShotFut + Send + 'static,
{
    oneshot_queue().lock().unwrap().push(OneShot {
        name: name.into(),
        due_ms: now_millis() + delay.as_millis() as i64,
        task: Box::new(task),
    });
}

/// Pure due-partition: removes and returns every entry whose due time has
/// passed — an entry can therefore fire at most once.
pub(crate) fn split_due(queue: &mut Vec<OneShot>, now_ms: i64) -> Vec<OneShot> {
    let mut due = Vec::new();
    let mut i = 0;
    while i < queue.len() {
        if queue[i].due_ms <= now_ms {
            due.push(queue.remove(i));
        } else {
            i += 1;
        }
    }
    due
}

fn take_due_oneshots(now_ms: i64) -> Vec<OneShot> {
    let mut q = oneshot_queue().lock().unwrap();
    split_due(&mut q, now_ms)
}

// ---------------------------------------------------------------------------
// The scheduler loop
// ---------------------------------------------------------------------------

/// Spawn the background keeper — the memory passes AND the watch bus, one
/// loop. Wakes every `TICK`; each wake (1) expires lapsed work-graph leases,
/// (2) drives the watch bus (due-cadence watches, then due scheduled
/// one-shots), and (3) runs the idle/growth/debounce-gated memory passes.
/// Async because the classifier/summarizer are async; runs on the Tauri
/// runtime.
pub(crate) fn spawn(ctx: WatchCtx) {
    tauri::async_runtime::spawn(async move {
        let app = ctx.app.clone();
        let db = ctx.db.clone();
        let mut last_run_ms: Option<i64> = None;
        // Seed every watch's last-check stamp to "now": the re-homed timers
        // all did their startup work at the setup site (immediate backup
        // snapshot, one-shot mirror sync), so each watch first fires one full
        // cadence after launch — exactly the retired threads' rhythm.
        let mut bus_last: HashMap<&'static str, i64> = {
            let t = now_millis();
            WATCHES.iter().map(|w| (w.name, t)).collect()
        };
        loop {
            tokio::time::sleep(TICK).await;
            let now = now_millis();

            // Work-graph lease expiry — EVERY tick, before the memory gates:
            // a lapsed claim must fall back to `open` on wall-clock time even
            // while idle/debounce/growth keep the memory passes parked.
            match db.expire_work_leases(now) {
                Ok(n) if n > 0 => tracing::info!(expired = n, "work leases lapsed back to open"),
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "work lease expiry failed"),
            }

            // --- the watch bus: due watches, then due one-shots. Runs every
            // tick, BEFORE the memory gates below can `continue` past it. ---
            run_bus(&mut bus_last, &ctx, now);
            for o in take_due_oneshots(now) {
                tracing::debug!(one_shot = %o.name, "scheduled one-shot due — running");
                tauri::async_runtime::spawn((o.task)());
            }

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

    /// The deterministic fallback keeps BOTH ends: a prompt states its ask at
    /// the top and lands its decision at the bottom, and a head-only window
    /// silently kept the first and destroyed the second.
    #[test]
    fn deterministic_gist_keeps_the_head_and_the_tail() {
        let body = format!("THE-ASK {} THE-DECISION", "filler ".repeat(400));
        let g = deterministic_gist(&body);
        assert!(g.starts_with("THE-ASK"), "the opening ask survives: {g}");
        assert!(g.contains("THE-DECISION"), "the closing decision survives: {g}");
        assert!(g.contains(" … "), "the middle is elided, not the end");
        assert!(g.chars().count() < body.chars().count());
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

    // --- the watch bus ------------------------------------------------------

    #[test]
    fn cadence_due_bookkeeping() {
        // Never checked → due now.
        assert!(cadence_due(None, 120_000, 1_000));
        // Inside the cadence → not due.
        assert!(!cadence_due(Some(1_000), 120_000, 120_999));
        // Exactly at the cadence boundary → due.
        assert!(cadence_due(Some(1_000), 120_000, 121_000));
        assert!(cadence_due(Some(1_000), 120_000, 500_000));
    }

    #[test]
    fn registry_rehomes_the_timers_with_their_cadences() {
        let find = |n: &str| {
            WATCHES
                .iter()
                .find(|w| w.name == n)
                .unwrap_or_else(|| panic!("watch {n} missing from the registry"))
        };
        // The re-homed timers keep their observable rhythms.
        assert_eq!(find("mirror-sync").cadence, Duration::from_secs(120));
        assert_eq!(find("ledger-backup").cadence, Duration::from_secs(6 * 3600));
        // The sweeps and the hub watch are registered, conservatively paced.
        assert_eq!(find("orchestrate-stall-sweep").cadence, Duration::from_secs(60));
        assert_eq!(find("review-staleness-sweep").cadence, Duration::from_secs(300));
        assert_eq!(find("ready-depth").cadence, Duration::from_secs(300));
        // The friction filer: conservative cadence, the keeper as its actor.
        assert_eq!(find("friction-filer").cadence, Duration::from_secs(6 * 3600));
        assert_eq!(find("friction-filer").target_role, "keeper");
        // Names are unique — the last-check map keys on them.
        let mut names: Vec<_> = WATCHES.iter().map(|w| w.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), WATCHES.len(), "duplicate watch names");
    }

    #[test]
    fn stall_sweep_fires_only_past_the_window_and_only_on_orchestrating() {
        let w = 300_000i64;
        let mut seen = HashMap::new();
        let orch = vec!["a".to_string()];
        // First observation starts the clock — never fires.
        assert!(stall_sweep_mark(&mut seen, &orch, 1_000, w).is_empty());
        // Still inside the window — no fire.
        assert!(stall_sweep_mark(&mut seen, &orch, 1_000 + w - 1, w).is_empty());
        // At the window — fires.
        assert_eq!(stall_sweep_mark(&mut seen, &orch, 1_000 + w, w), vec!["a".to_string()]);
        // A session that LEFT orchestrating is dropped (a beacon landed)…
        assert!(stall_sweep_mark(&mut seen, &[], 1_000 + w * 2, w).is_empty());
        assert!(seen.is_empty(), "departed session must drop its clock");
        // …and a later return restarts the clock instead of firing instantly.
        assert!(stall_sweep_mark(&mut seen, &orch, 1_000 + w * 3, w).is_empty());
    }

    #[test]
    fn staleness_step_needs_two_consecutive_sightings() {
        let one: HashSet<String> = ["s1".to_string()].into_iter().collect();
        // First sighting: no detach, carried as a suspect.
        let (detach, carried) = staleness_step(&HashSet::new(), &one);
        assert!(detach.is_empty());
        assert!(carried.contains("s1"));
        // Second consecutive sighting: detached, and not carried again.
        let (detach, carried) = staleness_step(&carried, &one);
        assert_eq!(detach, vec!["s1".to_string()]);
        assert!(carried.is_empty());
        // A suspect that resolved in between is simply forgotten.
        let (detach, carried) = staleness_step(&one, &HashSet::new());
        assert!(detach.is_empty() && carried.is_empty());
    }

    #[test]
    fn ready_depth_gate_and_threshold() {
        let t = READY_DEPTH_THRESHOLD;
        // Disabled queue → NEVER fires, even far over threshold.
        assert!(!ready_depth_should_fire(false, true, t * 10, t));
        // Enabled but not idle → no fire.
        assert!(!ready_depth_should_fire(true, false, t * 10, t));
        // Enabled + idle but under threshold → no fire.
        assert!(!ready_depth_should_fire(true, true, t - 1, t));
        // Enabled + idle + at-or-over threshold → nudges.
        assert!(ready_depth_should_fire(true, true, t, t));
        assert!(ready_depth_should_fire(true, true, t + 5, t));
    }

    // --- the friction filer (producers wave) --------------------------------

    #[test]
    fn friction_step_files_on_crossing_and_lowers_decayed_marks() {
        let t = FRICTION_FILE_THRESHOLD;
        let counts = vec![
            ("hook_timeout".to_string(), t + 1), // over threshold, no mark → file
            ("spawn_fail".to_string(), t - 1),   // under threshold → nothing
            ("carried".to_string(), t),          // at threshold but not above mark
            ("decayed".to_string(), 1),          // window slid under its mark
        ];
        let marks: HashMap<String, i64> = [
            ("carried".to_string(), t),
            ("decayed".to_string(), t + 3),
        ]
        .into_iter()
        .collect();
        let (to_file, to_lower) = friction_step(&counts, &marks, t);
        assert_eq!(to_file, vec![("hook_timeout".to_string(), t + 1)]);
        assert_eq!(to_lower, vec![("decayed".to_string(), 1)]);
        // After a lowering, a re-surge past the threshold crosses again.
        let resurged = vec![("decayed".to_string(), t)];
        let lowered: HashMap<String, i64> = [("decayed".to_string(), 1)].into_iter().collect();
        let (to_file, _) = friction_step(&resurged, &lowered, t);
        assert_eq!(to_file.len(), 1);
        // Empty inputs are quiet.
        assert_eq!(friction_step(&[], &HashMap::new(), t), (vec![], vec![]));
    }

    #[test]
    fn friction_filer_files_one_bug_per_kind_with_marks_and_seat_credit() {
        let db = Database::open_in_memory().unwrap();
        for _ in 0..6 {
            db.record_friction("hook_timeout", Some("plan"), None, Some("hook died"))
                .unwrap();
        }
        db.record_friction("spawn_fail", None, None, None).unwrap(); // under threshold
        assert_eq!(
            file_friction_items(&db, FRICTION_WINDOW_MS, FRICTION_FILE_THRESHOLD),
            1
        );
        let items = db.list_work_items(None, None, 50).unwrap();
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.kind, "bug");
        assert_eq!(item.status, "open");
        assert_eq!(item.origin_kind.as_deref(), Some("friction"));
        assert_eq!(item.origin_id.as_deref(), Some("hook_timeout"));
        assert!(item.title.contains("hook_timeout"));
        assert!(item.title.contains("6×"));
        assert!(item.body.as_deref().unwrap().contains("hook died"));
        // The high-water mark persisted through the house settings pattern.
        assert_eq!(
            db.get_setting("redline.frictionWatch.highWater.hook_timeout")
                .as_deref(),
            Some("6")
        );
        // The keeper seat's items_filed became real.
        assert_eq!(db.get_seat_stat("keeper").unwrap().items_filed, 1);
        assert!(db.verify_ledger_chain().unwrap().ok, "chain intact");
    }

    #[test]
    fn friction_filer_is_high_water_gated_and_refiles_after_close() {
        let db = Database::open_in_memory().unwrap();
        for _ in 0..5 {
            db.record_friction("hook_timeout", None, None, None).unwrap();
        }
        assert_eq!(
            file_friction_items(&db, FRICTION_WINDOW_MS, FRICTION_FILE_THRESHOLD),
            1
        );
        // Re-running with nothing new files nothing (count == mark).
        assert_eq!(
            file_friction_items(&db, FRICTION_WINDOW_MS, FRICTION_FILE_THRESHOLD),
            0
        );
        // More events cross the mark, but the UNCLOSED item is the belt: no
        // second item — the mark just advances so the watch goes quiet.
        db.record_friction("hook_timeout", None, None, None).unwrap();
        assert_eq!(
            file_friction_items(&db, FRICTION_WINDOW_MS, FRICTION_FILE_THRESHOLD),
            0
        );
        assert_eq!(db.list_work_items(None, None, 50).unwrap().len(), 1);
        assert_eq!(
            db.get_setting("redline.frictionWatch.highWater.hook_timeout")
                .as_deref(),
            Some("6")
        );
        // Close the item; a genuine further crossing may honestly refile.
        let id = db
            .find_unclosed_work_item("friction", Some("hook_timeout"), None)
            .unwrap()
            .unwrap()
            .id;
        db.close_work_item(&id, Some("fixed"), now_millis()).unwrap();
        db.record_friction("hook_timeout", None, None, None).unwrap();
        assert_eq!(
            file_friction_items(&db, FRICTION_WINDOW_MS, FRICTION_FILE_THRESHOLD),
            1
        );
        assert_eq!(db.list_work_items(None, None, 50).unwrap().len(), 2);
        assert_eq!(db.get_seat_stat("keeper").unwrap().items_filed, 2);
    }

    #[test]
    fn schedule_once_fires_exactly_once() {
        let shot = |name: &str, due: i64| OneShot {
            name: name.to_string(),
            due_ms: due,
            task: Box::new(|| Box::pin(async {}) as OneShotFut),
        };
        let mut q = vec![shot("early", 1_000), shot("late", 5_000)];
        // Before anything is due: nothing fires, nothing is lost.
        assert!(split_due(&mut q, 999).is_empty());
        assert_eq!(q.len(), 2);
        // At the first due time: exactly that one fires and leaves the queue.
        let due = split_due(&mut q, 1_000);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].name, "early");
        assert_eq!(q.len(), 1);
        // Re-draining at the same instant re-fires nothing — once means once.
        assert!(split_due(&mut q, 1_000).is_empty());
        // The rest fires when its own time comes.
        assert_eq!(split_due(&mut q, 10_000).len(), 1);
        assert!(q.is_empty());
    }
}
