// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Reading the record: the answer pack, the Timeline page, the stats, the map, the thread tree. Lifted from Redline's `context.rs` in Session A5.

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

/// Clamp + default for `GET /v1/context/prompts`'s `?limit=`.
pub const PROMPT_LIMIT_MAX: i64 = 200;

/// Clamp + default `GET /v1/context/prompts`'s `?limit=`.
pub fn clamp_prompt_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(PROMPT_LIMIT_MAX).clamp(1, PROMPT_LIMIT_MAX)
}

/// Run a filtered prompt query and enforce the response byte budget. The DB
/// caps each body at 4000 chars already; this additionally drops trailing items
/// once the cumulative body size would exceed `MAX_CONTEXT_BYTES`, so a wide
/// `limit` on long prompts still can't blow up the response.
pub fn list_prompts(polis: &Polis<'_>, filters: &PromptFilters) -> Result<Vec<LakeItem>, String> {
    let db = polis.store;
    let mut items = db.list_context_prompts(filters).map_err(|e| e.to_string())?;
    let keep = budgeted_item_count(items.iter().map(|i| i.body.as_deref()));
    items.truncate(keep);
    Ok(items)
}

/// `build_stats` memoized on the ledger head. Five GROUP BY aggregations over
/// the whole lake, and the Memory surface's facet rails re-read them on every
/// `memory-changed` — which a browse capture burst fires repeatedly.
///
/// The head seq is a sound cache key because every axis this counts is derived
/// from a table that appends a ledger event when it changes: a prompt, an
/// event, a class link, an author. Nothing here can move without the head
/// moving, so a hit is never stale.
pub fn build_stats_cached(polis: &Polis<'_>) -> ContextStats {
    let db = polis.store;
    use std::sync::{Mutex, OnceLock};
    /// Minimum wall-clock between two rebuilds, ON TOP of the head-seq key.
    ///
    /// The head key alone is exactly wrong during the one situation that
    /// matters: a browse capture burst appends an event per page, so every
    /// poll sees a new head and rebuilds the full five-axis aggregate — the
    /// cache misses hardest precisely when the app is busiest. A 500 ms floor
    /// keeps the numbers live to the eye while collapsing a burst into one
    /// rebuild.
    const DEBOUNCE_MS: i64 = 500;
    static CACHE: OnceLock<Mutex<Option<(i64, i64, ContextStats)>>> = OnceLock::new();
    let cell = CACHE.get_or_init(|| Mutex::new(None));
    let head = db.max_ledger_seq().unwrap_or(0);
    let now = now_millis();
    if let Ok(guard) = cell.lock() {
        if let Some((at, built_ms, stats)) = guard.as_ref() {
            if *at == head || now - *built_ms < DEBOUNCE_MS {
                return stats.clone();
            }
        }
    }
    let fresh = build_stats(polis);
    if let Ok(mut guard) = cell.lock() {
        *guard = Some((head, now, fresh.clone()));
    }
    fresh
}

/// Build the stats digest. Best-effort per axis (an unmigrated table yields an
/// empty list rather than failing the whole response).
pub fn build_stats(polis: &Polis<'_>) -> ContextStats {
    let db = polis.store;
    let by_day = db.prompt_counts_by_day().unwrap_or_default();
    let by_surface = db.prompt_counts_by_surface().unwrap_or_default();
    let by_kind = db.event_counts_by_kind().unwrap_or_default();
    let by_class = db.class_link_counts_by_root().unwrap_or_default();
    let by_author = db.event_counts_by_author().unwrap_or_default();
    let total_prompts = by_surface.iter().map(|(_, c)| c).sum();
    let total_events = db.max_ledger_seq().unwrap_or(0);
    ContextStats {
        generated_ts: now_millis(),
        total_prompts,
        total_events,
        by_day,
        by_surface,
        by_kind,
        by_class,
        by_author,
    }
}

/// Assemble the Map: accepted classes + session-tree threads (plus sessions a
/// supersession resolves to), with the four declared edge kinds. Everything is
/// ordered (nodes by id, edges by kind/from/to) so the payload — and therefore
/// the seeded layout downstream — is deterministic. Best-effort per source: a
/// missing table yields empty buckets, never an error (some event kinds may
/// never have fired; the Map must render an honest empty state).
pub fn build_memory_map(polis: &Polis<'_>) -> MemoryMapView {
    let db = polis.store;
    use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

    let mut nodes: Vec<MapNode> = Vec::new();
    let mut edges: Vec<MapEdge> = Vec::new();

    // --- classes (accepted only — proposed nodes are not yet on the record) --
    let all_classes = db.list_class_nodes_with_counts().unwrap_or_default();
    let accepted: Vec<&(polis_core::types::ClassNode, i64)> = all_classes
        .iter()
        .filter(|(n, _)| n.status == "accepted")
        .collect();
    let accepted_ids: HashSet<&str> = accepted.iter().map(|(n, _)| n.id.as_str()).collect();
    let mut class_parent: HashMap<&str, &str> = HashMap::new();
    let mut class_project: HashMap<&str, Option<&str>> = HashMap::new();
    for (n, count) in &accepted {
        let parent = n
            .parent_id
            .as_deref()
            .filter(|p| accepted_ids.contains(p));
        if let Some(p) = parent {
            class_parent.insert(n.id.as_str(), p);
            edges.push(MapEdge {
                kind: "contains".into(),
                from: format!("class:{p}"),
                to: format!("class:{}", n.id),
                weight: 1,
                basis: None,
            });
        }
        class_project.insert(n.id.as_str(), n.project_path.as_deref());
        nodes.push(MapNode {
            id: format!("class:{}", n.id),
            kind: if n.kind == "digest" { "digest" } else { "class" }.into(),
            label: n.title.clone(),
            mass: *count,
            parent_id: parent.map(|p| format!("class:{p}")),
            pinned: n.pinned,
            project_path: n.project_path.clone(),
            class_node_id: Some(n.id.clone()),
            session_id: None,
            browse_id: None,
            thread_id: None,
        });
    }

    // --- session tree (lineage) ---------------------------------------------
    let tree_rows = db.list_session_tree_rows().unwrap_or_default();
    let mut threads: BTreeSet<(String, String)> = BTreeSet::new();
    let mut thread_parent: HashMap<(String, String), (String, String)> = HashMap::new();
    for (ck, cid, pk, pid) in &tree_rows {
        threads.insert((ck.clone(), cid.clone()));
        threads.insert((pk.clone(), pid.clone()));
        thread_parent
            .entry((ck.clone(), cid.clone()))
            .or_insert_with(|| (pk.clone(), pid.clone()));
        edges.push(MapEdge {
            kind: "lineage".into(),
            from: format!("thread:{pk}:{pid}"),
            to: format!("thread:{ck}:{cid}"),
            weight: 1,
            basis: None,
        });
    }

    // --- supersedes (decision chain, endpoints mapped per rule 1) -----------
    let pairs = db.list_supersession_pairs().unwrap_or_default();
    let seqs: Vec<i64> = pairs.iter().flat_map(|&(o, n)| [o, n]).collect();
    let endpoints = db.resolve_map_endpoints(&seqs).unwrap_or_default();
    // A decision lands on its class when filed, its session otherwise. A
    // session seen only here still becomes a node — it hosts a decision.
    let resolve = |seq: i64, threads: &mut BTreeSet<(String, String)>| -> Option<String> {
        let (session, class) = endpoints.get(&seq)?;
        if let Some(c) = class.as_deref().filter(|c| accepted_ids.contains(c)) {
            return Some(format!("class:{c}"));
        }
        let sid = session.as_deref()?;
        threads.insert(("session".into(), sid.to_string()));
        Some(format!("thread:session:{sid}"))
    };
    let mut chain: BTreeMap<(String, String), (i64, String)> = BTreeMap::new();
    for (old, new) in &pairs {
        let (Some(from), Some(to)) = (
            resolve(*old, &mut threads),
            resolve(*new, &mut threads),
        ) else {
            continue;
        };
        if from == to {
            continue;
        }
        let entry = chain
            .entry((from, to))
            .or_insert_with(|| (0, format!("#{old} → #{new}")));
        entry.0 += 1;
    }
    for ((from, to), (weight, basis)) in chain {
        edges.push(MapEdge {
            kind: "supersedes".into(),
            from,
            to,
            weight,
            basis: Some(basis),
        });
    }

    // --- thread nodes (labels + message-count mass, resolved per node) ------
    for (kind, id) in &threads {
        let (count, _) = polis.thread_stats(kind, id).unwrap_or((0, None));
        let label = polis.thread_label(kind, id)
            .unwrap_or_else(|| format!("{kind} {}", id.chars().take(8).collect::<String>()));
        let is_session = kind == "session";
        let is_browse = kind == "browse";
        nodes.push(MapNode {
            id: format!("thread:{kind}:{id}"),
            kind: if is_session { "session" } else { "thread" }.into(),
            label,
            mass: count,
            parent_id: thread_parent
                .get(&(kind.clone(), id.clone()))
                .map(|(pk, pid)| format!("thread:{pk}:{pid}")),
            pinned: false,
            project_path: None,
            class_node_id: None,
            session_id: is_session.then(|| id.clone()),
            browse_id: is_browse.then(|| id.clone()),
            thread_id: (!is_session && !is_browse).then(|| id.clone()),
        });
    }

    // --- co-occurs (the one derived edge, opt-in downstream) ----------------
    // Classes sharing sessions (through their accepted links) or a project
    // while filed apart. Direct parent↔child pairs are skipped — `contains`
    // already states that relation; the signal here is UNEXPECTED adjacency.
    let mut sessions_by_class: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let pairs = db.class_session_pairs().unwrap_or_default();
    for (node, session) in &pairs {
        if accepted_ids.contains(node.as_str()) {
            sessions_by_class
                .entry(node.as_str())
                .or_default()
                .insert(session.as_str());
        }
    }
    let mut class_list: Vec<&str> = accepted_ids.iter().copied().collect();
    class_list.sort_unstable();
    for (i, a) in class_list.iter().enumerate() {
        for b in &class_list[i + 1..] {
            if class_parent.get(a) == Some(b) || class_parent.get(b) == Some(a) {
                continue;
            }
            let shared = match (sessions_by_class.get(a), sessions_by_class.get(b)) {
                (Some(sa), Some(sb)) => sa.intersection(sb).count() as i64,
                _ => 0,
            };
            let same_project = matches!(
                (class_project.get(a), class_project.get(b)),
                (Some(Some(pa)), Some(Some(pb))) if pa == pb
            );
            if shared == 0 && !same_project {
                continue;
            }
            let basis = match (shared, same_project) {
                (0, _) => "shared project".to_string(),
                (n, false) => format!("{n} shared session{}", if n == 1 { "" } else { "s" }),
                (n, true) => format!(
                    "{n} shared session{} · project",
                    if n == 1 { "" } else { "s" }
                ),
            };
            edges.push(MapEdge {
                kind: "co_occurs".into(),
                from: format!("class:{a}"),
                to: format!("class:{b}"),
                weight: shared + i64::from(same_project),
                basis: Some(basis),
            });
        }
    }

    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    edges.sort_by(|a, b| {
        (a.kind.as_str(), a.from.as_str(), a.to.as_str())
            .cmp(&(b.kind.as_str(), b.from.as_str(), b.to.as_str()))
    });
    MemoryMapView {
        generated_ts: now_millis(),
        nodes,
        edges,
    }
}

/// Assemble the pack. Every list is bounded by `limit`, and the whole response
/// is bounded by `MAX_CONTEXT_BYTES` — trimming links, then prompt hits, then
/// browse hits, and the user's notes only if nothing else is left to give.
pub fn build_answer_pack(
    polis: &Polis<'_>,
    q: Option<&str>,
    node_id: Option<&str>,
    limit: i64,
) -> AnswerPack {
    let db = polis.store;
    let head_seq = db.max_ledger_seq().unwrap_or(0);
    let query = q.map(str::trim).filter(|s| !s.is_empty());

    // --- resolve a node: the explicit id first, then the best title match ---
    let mut matched: Vec<polis_core::types::ClassNode> = query
        .map(|term| db.match_class_nodes(term, limit).unwrap_or_default())
        .unwrap_or_default();
    let resolved = node_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|id| db.get_class_node(id).ok().flatten())
        // A stale `?node=` falls through to the best lexical match rather than
        // returning nothing — the miss path.
        .or_else(|| matched.first().cloned());
    if let Some(r) = &resolved {
        matched.retain(|n| n.id != r.id);
    }

    // Per-list ceilings applied BEFORE the byte budget. A bulging class can
    // hold thousands of links, and feeding all of them into a trim loop that
    // re-serializes per dropped item is quadratic on exactly the nodes most
    // worth asking about. The budget below still has the final say.
    let node_cap = (limit * 5).max(20) as usize;
    let mut over_cap: Vec<&str> = Vec::new();
    let node = resolved.map(|node| {
        let mut children = db.list_class_children(&node.id).unwrap_or_default();
        // ONE query for the whole generation, not one per child — the same
        // N+1 the Timeline's filing probe had, in the route that is supposed
        // to be the fast one. A node with 40 children cost 40 round trips
        // through the connection lock to build a list the pack then caps.
        // (`link_previews_for_seqs` is the idiom.)
        let child_ids: Vec<String> = children.iter().map(|c| c.id.clone()).collect();
        let mut grandchildren = db.list_class_children_for_parents(&child_ids).unwrap_or_default();
        if children.len() > node_cap {
            children.truncate(node_cap);
            over_cap.push("children");
        }
        if grandchildren.len() > node_cap {
            grandchildren.truncate(node_cap);
            over_cap.push("grandchildren");
        }
        let mut raw_links = db.list_class_links_for_node(&node.id).unwrap_or_default();
        if raw_links.len() > node_cap {
            raw_links.truncate(node_cap);
            over_cap.push("links");
        }
        let ledger_seq = |l: &polis_core::types::ClassLink| -> Option<i64> {
            matches!(l.target_kind.as_str(), "prompt" | "decision" | "ledger")
                .then(|| l.target_id.trim().parse().ok())
                .flatten()
        };
        let seqs: Vec<i64> = raw_links.iter().filter_map(ledger_seq).collect();
        // Two batched reads for the whole link set, not two per link.
        let labels = db.link_previews_for_seqs(&seqs).unwrap_or_default();
        let superseded = db.supersessions_for_seqs(&seqs).unwrap_or_default();
        let links: Vec<PackLink> = raw_links
            .into_iter()
            .map(|link| {
                let seq = ledger_seq(&link);
                PackLink {
                    label: seq.and_then(|s| labels.get(&s).cloned()),
                    superseded_by: seq.and_then(|s| superseded.get(&s).copied()),
                    link,
                }
            })
            .collect();
        let mut observations = db.list_class_observations(&node.id, false).unwrap_or_default();
        if observations.len() > node_cap {
            observations.truncate(node_cap);
            over_cap.push("observations");
        }
        PackNode { node, children, grandchildren, links, observations }
    });

    // --- lexical evidence: always produced, node or no node ---
    let notes = query
        .map(|term| db.search_user_notes(term, limit).unwrap_or_default())
        .unwrap_or_default();
    let plan = query.and_then(polis_core::query::plan_fts_query);
    let terms: Vec<String> = plan.as_ref().map(|p| p.terms.clone()).unwrap_or_default();

    let mut ranked = query
        .map(|term| {
            db.search_prompts_ranked(term, limit).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "answer-pack: prompt search failed");
                Vec::new()
            })
        })
        .unwrap_or_default();

    // --- the semantic arm, and the FUSE the pipeline is named for ------------
    //
    // The arm reaches what shares no words with the question. It runs last and
    // it never replaces the lexical ordering — RRF fuses the two, so a hit both
    // arms found rises and a hit only one found still appears.
    //
    // Its absence is a first-class state: `provider_kind() == Absent` means no
    // on-device model (or a macOS below 14 with no sentence fallback either),
    // and the pack SAYS so rather than returning a short list that reads as an
    // empty history.
    let semantic = query.and_then(|term| {
        crate::semantic_search(polis, term, (limit * 3).max(24) as usize)
    });
    let semantic_prompt_hits: Vec<(i64, f64)> = semantic
        .as_ref()
        .map(|hits| {
            hits.iter()
                .filter(|h| h.target_kind == "prompt")
                .map(|h| (h.target_id, h.score as f64))
                .collect()
        })
        .unwrap_or_default();

    // Fuse the two prompt rankings. Keys are ledger seqs for the lexical arm
    // and prompt ids for the semantic one, so the semantic ids are resolved to
    // seqs first — a fusion over two different id-spaces would silently agree
    // with itself about nothing.
    let arms_by_seq: std::collections::HashMap<i64, Vec<ArmHit>> = if semantic_prompt_hits.is_empty()
    {
        std::collections::HashMap::new()
    } else {
        let ids: Vec<i64> = semantic_prompt_hits.iter().map(|(id, _)| *id).collect();
        let seq_of = db.seqs_for_prompt_ids(&ids).unwrap_or_default();
        let lexical: Vec<(String, f64)> = ranked
            .iter()
            .enumerate()
            .map(|(i, (it, _))| (it.seq.to_string(), -(i as f64)))
            .collect();
        let sem: Vec<(String, f64)> = semantic_prompt_hits
            .iter()
            .filter_map(|(id, s)| seq_of.get(id).map(|seq| (seq.to_string(), *s)))
            .collect();
        let fused = rrf_fuse(&[(Arm::Lexical, lexical), (Arm::Semantic, sem)]);

        // Reorder the lexical results by the fused score, then append any
        // semantic-only hits the lexical arm never saw. Appending rather than
        // interleaving is deliberate: a hit no term matched is weaker evidence
        // and should not displace one that did.
        let order: std::collections::HashMap<i64, usize> = fused
            .iter()
            .enumerate()
            .filter_map(|(rank, (k, _, _))| k.parse::<i64>().ok().map(|s| (s, rank)))
            .collect();
        ranked.sort_by_key(|(it, _)| order.get(&it.seq).copied().unwrap_or(usize::MAX));

        let known: std::collections::HashSet<i64> = ranked.iter().map(|(it, _)| it.seq).collect();
        let extra: Vec<i64> = fused
            .iter()
            .filter_map(|(k, _, _)| k.parse::<i64>().ok())
            .filter(|s| !known.contains(s))
            .take(limit as usize)
            .collect();
        if !extra.is_empty() {
            if let Ok(items) = db.lake_items_for_seqs(&extra) {
                ranked.extend(items.into_iter().map(|it| (it, polis_core::query::MatchStage::Or)));
            }
        }
        fused
            .into_iter()
            .filter_map(|(k, arms, _)| k.parse::<i64>().ok().map(|s| (s, arms)))
            .collect()
    };

    // fuse → DEDUP → CLIP → budget. The order is the fix: deduplicating after
    // clipping cannot work, because a head clip makes near-duplicates
    // byte-identical and clipping to a fixed 4,000 makes the budget's job
    // impossible. The live probe returned four copies of one preface and then
    // dropped every browse hit to fit them.
    let prompt_hits = {
        let bodies: Vec<String> = ranked
            .iter()
            .map(|(it, _)| it.body.clone().unwrap_or_default())
            .collect();
        let cands: Vec<polis_core::dedup::Candidate<'_>> = ranked
            .iter()
            .zip(bodies.iter())
            .map(|((it, _), body)| polis_core::dedup::Candidate {
                key: it.seq,
                // The lake's own exact-identity key, already stored and indexed.
                exact_hash: None,
                text: body.as_str(),
            })
            .collect();
        let verdicts = polis_core::dedup::dedup(&cands);
        let survivors: Vec<usize> = verdicts
            .iter()
            .enumerate()
            .filter(|(_, v)| matches!(v, polis_core::dedup::Verdict::Keep { .. }))
            .map(|(i, _)| i)
            .collect();
        // Per-hit budget is computed over the SURVIVORS, so suppressing
        // duplicates buys the remaining hits more room rather than less.
        let per_hit = polis_core::dedup::per_hit_budget(MAX_CONTEXT_BYTES, survivors.len());
        let hit_seqs: Vec<i64> = survivors.iter().map(|i| ranked[*i].0.seq).collect();
        let hit_superseded = db.supersessions_for_seqs(&hit_seqs).unwrap_or_default();
        survivors
            .into_iter()
            .map(|i| {
                let (item, stage) = ranked[i].clone();
                let absorbed = match &verdicts[i] {
                    polis_core::dedup::Verdict::Keep { absorbed } => absorbed.clone(),
                    polis_core::dedup::Verdict::Duplicate { .. } => Vec::new(),
                };
                let mut item = item;
                item.body = item
                    .body
                    .map(|b| polis_core::dedup::excerpt_around(&b, &terms, per_hit));
                PackPromptHit {
                    superseded_by: hit_superseded.get(&item.seq).copied(),
                    duplicate_of: absorbed,
                    stage: stage.as_str().to_string(),
                    arms: arms_by_seq.get(&item.seq).cloned().unwrap_or_default(),
                    item,
                }
            })
            .collect::<Vec<_>>()
    };

    // Browse events carry their own exact-identity key — `context_hash`, the
    // sha256 of the normalized DOM — and 20% of them are exact duplicates today
    // (829 rows, 665 distinct). Revisiting a page is a real signal about
    // attention, but four identical copies of it are not four pieces of evidence.
    let browse_hits = {
        let raw = query
            .map(|term| db.search_browse_events(term, limit).unwrap_or_default())
            .unwrap_or_default();
        let hashes = db
            .context_hashes_for_browse_ids(&raw.iter().map(|h| h.id).collect::<Vec<_>>())
            .unwrap_or_default();
        let texts: Vec<String> = raw
            .iter()
            .map(|h| format!("{} {}", h.title.clone().unwrap_or_default(), h.url))
            .collect();
        let cands: Vec<polis_core::dedup::Candidate<'_>> = raw
            .iter()
            .zip(texts.iter())
            .map(|(h, t)| polis_core::dedup::Candidate {
                key: h.seq.unwrap_or(h.id),
                exact_hash: hashes.get(&h.id).map(String::as_str),
                text: t.as_str(),
            })
            .collect();
        let verdicts = polis_core::dedup::dedup(&cands);
        raw.into_iter()
            .zip(verdicts.iter())
            .filter(|(_, v)| matches!(v, polis_core::dedup::Verdict::Keep { .. }))
            .map(|(h, _)| h)
            .collect::<Vec<_>>()
    };

    // The grep arm runs only when the question reaches for a literal. Its
    // needle is the longest quoted phrase, else the longest term — the most
    // specific thing the user actually typed.
    let literal_query = matches!((&plan, query), (Some(p), Some(raw)) if polis_core::query::looks_literal(p, raw));
    let grep_hits = match (&plan, query) {
        (Some(plan), Some(raw)) if polis_core::query::looks_literal(plan, raw) => {
            let needle = plan
                .phrases
                .iter()
                .chain(plan.terms.iter())
                .max_by_key(|t| t.chars().count())
                .cloned()
                .unwrap_or_default();
            db.grep_memory(&needle, None, false, polis_core::types::GrepScope::All, limit)
                .unwrap_or_default()
        }
        _ => Vec::new(),
    };

    // Every arm reports whether it RAN, not just what it returned.
    let arm_coverage = vec![
        ArmCoverage {
            arm: Arm::Node,
            ran: query.is_some() || node_id.is_some(),
            hits: usize::from(node.is_some()) + matched.len(),
            absent_because: None,
        },
        ArmCoverage {
            arm: Arm::Note,
            ran: query.is_some(),
            hits: notes.len(),
            absent_because: None,
        },
        ArmCoverage {
            arm: Arm::Lexical,
            ran: query.is_some(),
            hits: prompt_hits.len() + browse_hits.len(),
            absent_because: None,
        },
        ArmCoverage {
            arm: Arm::Grep,
            ran: !grep_hits.is_empty() || literal_query,
            hits: grep_hits.len(),
            absent_because: (!literal_query).then(|| {
                "the question doesn't name a literal (a flag, a path, an identifier)".to_string()
            }),
        },
        ArmCoverage {
            arm: Arm::Semantic,
            ran: semantic.is_some(),
            hits: semantic.as_ref().map(Vec::len).unwrap_or(0),
            absent_because: semantic.is_none().then(|| {
                match polis.provider_kind() {
                    polis_embed::ProviderKind::Absent => {
                        "no on-device embedding provider is available".to_string()
                    }
                    _ => "the semantic index is not built yet".to_string(),
                }
            }),
        },
    ];

    let mut pack = AnswerPack {
        head_seq,
        query: query.map(str::to_string),
        node,
        matched_nodes: matched,
        notes,
        prompt_hits,
        browse_hits,
        grep_hits,
        arm_coverage,
        truncated: over_cap.into_iter().map(str::to_string).collect(),
    };
    enforce_pack_budget(&mut pack);
    pack
}

/// One session-tree node with its parent and child digests — shared by
/// `GET /v1/context/tree/:kind/:id` AND the `context_thread_tree` command
/// (same assembly, two thin callers, so route and GUI can't drift).
pub fn build_thread_tree(polis: &Polis<'_>, kind: &str, id: &str) -> serde_json::Value {
    let db = polis.store;
    let parent = db.session_tree_parent(kind, id).ok().flatten();
    let children = db.session_tree_children(kind, id).unwrap_or_default();
    let child_digests: Vec<serde_json::Value> = children
        .into_iter()
        .map(|(ck, cid, created_at)| {
            let (count, last_ts) = polis.thread_stats(&ck, &cid).unwrap_or((0, None));
            serde_json::json!({
                "kind": ck,
                "id": cid,
                "label": polis.thread_label(&ck, &cid),
                "createdAt": created_at,
                "messageCount": count,
                "lastTs": last_ts,
            })
        })
        .collect();
    let (count, last_ts) = polis.thread_stats(kind, id).unwrap_or((0, None));
    serde_json::json!({
        "node": {
            "kind": kind,
            "id": id,
            "label": polis.thread_label(kind, id),
            "messageCount": count,
            "lastTs": last_ts,
        },
        "parent": parent.map(|(pk, pid)| serde_json::json!({
            "kind": pk,
            "id": pid,
            "label": polis.thread_label(&pk, &pid),
        })),
        "children": child_digests,
    })
}

// ---------------------------------------------------------------------------
// The route views (Session A5): what `/v1/memory/tree`, `/v1/memory/node/:id`
// and the Timeline serve — assembled here so the HTTP router, the MCP tools
// and a host's handlers all build one shape.
// ---------------------------------------------------------------------------

use polis_core::api::{LinkView, NodeView, TreeNodeView};

/// The Timeline page — the store's rows with the host's own pictures joined
/// (`HostResolver::surface_shot_keys`).
pub fn query_ledger(polis: &Polis<'_>, f: &LedgerFilters) -> Result<Vec<TimelineItem>, String> {
    polis.query_ledger_events(f).map_err(|e| e.to_string())
}

/// The catalog as the tree route serves it: every node with its link count,
/// optionally one root (by id, or by the project path bound to it).
pub fn tree_view(
    polis: &Polis<'_>,
    root: Option<&str>,
    project: Option<&str>,
) -> rusqlite::Result<Vec<TreeNodeView>> {
    let all = polis.store.list_class_nodes_with_counts()?;
    let root_id: Option<String> = if let Some(r) = root.filter(|s| !s.trim().is_empty()) {
        Some(r.trim().to_string())
    } else if let Some(p) = project.filter(|s| !s.trim().is_empty()) {
        all.iter()
            .find(|(n, _)| n.parent_id.is_none() && n.project_path.as_deref() == Some(p.trim()))
            .map(|(n, _)| n.id.clone())
    } else {
        None
    };
    Ok(match &root_id {
        Some(rid) => {
            let keep = subtree_ids(&all, rid);
            all.into_iter()
                .filter(|(n, _)| keep.contains(&n.id))
                .map(|(node, link_count)| TreeNodeView { node, link_count })
                .collect()
        }
        None => all.into_iter().map(|(node, link_count)| TreeNodeView { node, link_count }).collect(),
    })
}

fn subtree_ids(all: &[(ClassNode, i64)], root: &str) -> std::collections::HashSet<String> {
    let mut keep = std::collections::HashSet::new();
    keep.insert(root.to_string());
    // Iterate to a fixpoint (tree is small).
    loop {
        let before = keep.len();
        for (n, _) in all {
            if let Some(p) = &n.parent_id {
                if keep.contains(p) {
                    keep.insert(n.id.clone());
                }
            }
        }
        if keep.len() == before {
            break;
        }
    }
    keep
}

/// One node with its children, decorated links (lake label + supersession
/// status) and observations — the node route.
pub fn node_view(polis: &Polis<'_>, id: &str) -> rusqlite::Result<Option<NodeView>> {
    let db = polis.store;
    let Some(node) = db.get_class_node(id)? else {
        return Ok(None);
    };
    let children = db.list_class_children(id)?;
    let raw_links = db.list_class_links_for_node(id)?;
    let ledger_seq = |l: &ClassLink| -> Option<i64> {
        matches!(l.target_kind.as_str(), "prompt" | "decision" | "ledger")
            .then(|| l.target_id.trim().parse().ok())
            .flatten()
    };
    let seqs: Vec<i64> = raw_links.iter().filter_map(&ledger_seq).collect();
    let labels = db.link_previews_for_seqs(&seqs).unwrap_or_default();
    let superseded = db.supersessions_for_seqs(&seqs).unwrap_or_default();
    let links: Vec<LinkView> = raw_links
        .into_iter()
        .map(|link| {
            let seq = ledger_seq(&link);
            LinkView {
                label: seq.and_then(|s| labels.get(&s).cloned()),
                superseded_by: seq.and_then(|s| superseded.get(&s).copied()),
                link,
            }
        })
        .collect();
    let observations = db.list_class_observations(id, false)?;
    Ok(Some(NodeView { node, children, links, observations }))
}
