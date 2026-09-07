// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The answer pack — ONE batched read that answers most memory questions —
//! as a vocabulary: its types, its byte budget, Reciprocal Rank Fusion across
//! the retrieval arms, and the compact evidence render that rides inside a
//! prompt. Assembly against a store lives with the store; everything here is
//! pure and is what the server, the MCP tools and the clients agree on.

use serde::Serialize;

use crate::query::FtsPlan;
use crate::types::{LakeItem, UserNote};

/// Byte budget on the `/v1/context/prompts` response (mirrors `code.rs`'s 60KB).
pub const MAX_CONTEXT_BYTES: usize = 60_000;

/// How many leading items fit in `MAX_CONTEXT_BYTES`, given each one's body.
/// Always at least one (a single oversized item is truncated by the DB layer,
/// not dropped — an empty response would read as "nothing recorded").
///
/// Shared by `/v1/context/prompts` and `/v1/memory/prompts`: an item cap alone
/// is not a bound when one item can be a 40KB page snapshot.
pub fn budgeted_item_count<'a>(bodies: impl Iterator<Item = Option<&'a str>>) -> usize {
    let mut budget = MAX_CONTEXT_BYTES;
    let mut keep = 0usize;
    for body in bodies {
        // ~120 bytes of metadata overhead per item + the (truncated) body.
        let cost = 120 + body.map(str::len).unwrap_or(0);
        if keep > 0 && cost > budget {
            break;
        }
        budget = budget.saturating_sub(cost);
        keep += 1;
    }
    keep
}

/// Default `?limit=` on each list inside the answer pack.
pub const ANSWER_PACK_LIMIT: i64 = 20;
/// Clamp on that limit — a caller can widen a list, not unbound it.
pub const ANSWER_PACK_LIMIT_MAX: i64 = 60;

pub fn clamp_answer_pack_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(ANSWER_PACK_LIMIT)
        .clamp(1, ANSWER_PACK_LIMIT_MAX)
}

/// One link out of the resolved node, with its label and supersession status
/// resolved — the same `(label, supersededBy)` decoration
/// `GET /v1/memory/node/:id` carries, so an agent reading the pack and an agent
/// reading the node route see one shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackLink {
    #[serde(flatten)]
    pub link: crate::types::ClassLink,
    pub label: Option<String>,
    /// The decision seq that superseded this link's target (`None` = current).
    pub superseded_by: Option<i64>,
}

/// The resolved node and everything hanging off it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackNode {
    pub node: crate::types::ClassNode,
    /// Children to depth 2 — enough for the agent to see where to descend
    /// next without a second call.
    pub children: Vec<crate::types::ClassNode>,
    pub grandchildren: Vec<crate::types::ClassNode>,
    pub links: Vec<PackLink>,
    pub observations: Vec<crate::types::ClassObservation>,
}

/// A matching prompt from the lake, carrying its supersession status so a
/// stale decision can't be read back as current.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPromptHit {
    #[serde(flatten)]
    pub item: LakeItem,
    pub superseded_by: Option<i64>,
    /// Other hits that collapsed into this one — same body, or the same framing
    /// around a different question. Reported rather than hidden: "four copies"
    /// and "one copy, three duplicates suppressed" are different facts about
    /// the record, and the second is the true one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub duplicate_of: Vec<i64>,
    /// Which stage of the query cascade found this: `and` (every term present)
    /// or `or` (widened) or `like` (substring fallback).
    pub stage: String,
    /// Every arm that found this hit, with its rank and score there. A hit
    /// found by two arms is stronger evidence than one found by either alone,
    /// and a `semantic`-only hit is *associated* rather than asserted — see
    /// [`Arm`] for the trust ordering.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub arms: Vec<ArmHit>,
}

/// One batched read that answers most memory questions: the resolved class
/// node with its subtree, links and observations, plus the user's own matching
/// notes, matching prompts from the lake and matching pages from the browse
/// stream.
///
/// It exists to collapse a 5–7 turn retrieval walk into ONE tool call. Which
/// is why the miss path is a design requirement, not a nicety: `promptHits`,
/// `browseHits` and `matchedNodes` are always populated from the query text,
/// even when node resolution fails outright or a caller passes a stale
/// `?node=`. A resolution miss must still hand back lexical evidence — never
/// an empty pack that pushes the agent back into the walk it was built to
/// replace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerPack {
    /// The ledger head this pack was assembled at — the agent cites against it.
    pub head_seq: i64,
    pub query: Option<String>,
    /// `None` when nothing resolved; the lexical hits below still stand.
    pub node: Option<PackNode>,
    /// Runners-up from node resolution, so the agent can redirect in one step.
    pub matched_nodes: Vec<crate::types::ClassNode>,
    /// The user's own words — FIRST, and the last thing the budget trims.
    pub notes: Vec<UserNote>,
    pub prompt_hits: Vec<PackPromptHit>,
    pub browse_hits: Vec<crate::types::BrowseHit>,
    /// Literal/regex hits. Present only when the question LOOKS like it is
    /// reaching for a literal (a flag, a path, an identifier, a quoted phrase)
    /// — a trigram probe on every natural-language question would cost an index
    /// scan to return noise.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub grep_hits: Vec<crate::types::GrepHit>,
    /// Which arms ran, and what each returned. Read this before concluding
    /// anything from an empty list: an arm that did not run is ABSENT, which is
    /// a fact about the index rather than about the user's history.
    pub arm_coverage: Vec<ArmCoverage>,
    /// Which lists the byte budget cut, so the agent knows to narrow rather
    /// than conclude the record is empty.
    pub truncated: Vec<String>,
}


/// Trim the pack to `MAX_CONTEXT_BYTES` without ever letting one arm's results
/// erase another's.
///
/// The old rule was "drop whole lists in a fixed order, cheapest first", and it
/// had a failure mode the live probe hit exactly: browse hits were first in the
/// order, so a pack bloated by four copies of one preface dropped **every
/// page** before touching a single prompt. The user's question was answered
/// from one kind of evidence because the other kind was cheaper to delete.
///
/// The rule now: **every arm that produced anything keeps at least one hit.**
/// Above that floor, arms are trimmed in the same priority order (the user's
/// own notes dead last — they are the one human-authored signal), still in
/// proportional chunks, because each `size()` call re-serializes the pack and a
/// pop-one loop over a long list would be quadratic on exactly the biggest
/// packs. That chunking reasoning was sound and is kept verbatim.
///
/// An arm reduced to its floor is still reported in `truncated`: "one of many"
/// and "one, that's all there was" are different answers.
pub fn enforce_pack_budget(pack: &mut AnswerPack) {
    fn size(p: &AnswerPack) -> usize {
        serde_json::to_vec(p).map(|v| v.len()).unwrap_or(0)
    }
    if size(pack) <= MAX_CONTEXT_BYTES {
        return;
    }
    type Len = fn(&AnswerPack) -> usize;
    type Drop = fn(&mut AnswerPack, usize);
    /// Every arm that produced at least one hit keeps at least this many.
    const ARM_FLOOR: usize = 1;

    let steps: [(&str, Len, Drop); 5] = [
        ("browseHits", |p| p.browse_hits.len(), |p, n| {
            let keep = p.browse_hits.len().saturating_sub(n);
            p.browse_hits.truncate(keep);
        }),
        ("promptHits", |p| p.prompt_hits.len(), |p, n| {
            let keep = p.prompt_hits.len().saturating_sub(n);
            p.prompt_hits.truncate(keep);
        }),
        ("links", |p| p.node.as_ref().map(|n| n.links.len()).unwrap_or(0), |p, n| {
            if let Some(node) = p.node.as_mut() {
                let keep = node.links.len().saturating_sub(n);
                node.links.truncate(keep);
            }
        }),
        ("grepHits", |p| p.grep_hits.len(), |p, n| {
            let keep = p.grep_hits.len().saturating_sub(n);
            p.grep_hits.truncate(keep);
        }),
        ("notes", |p| p.notes.len(), |p, n| {
            let keep = p.notes.len().saturating_sub(n);
            p.notes.truncate(keep);
        }),
    ];

    // Pass one: trim every arm down towards its floor, in priority order.
    for (name, len, drop) in steps {
        let mut cut = false;
        while size(pack) > MAX_CONTEXT_BYTES && len(pack) > ARM_FLOOR {
            let over = len(pack) - ARM_FLOOR;
            drop(pack, (over / 4).max(1).min(over));
            cut = true;
        }
        if cut && !pack.truncated.iter().any(|t| t == name) {
            pack.truncated.push(name.to_string());
        }
        if size(pack) <= MAX_CONTEXT_BYTES {
            return;
        }
    }

    // Pass two: still over budget with every arm at its floor. Now the floor
    // itself has to give — but only after every arm has been reduced to it, so
    // what is lost is spread across the evidence rather than taken entirely
    // from whichever arm happened to sort first.
    for (name, len, drop) in steps {
        while size(pack) > MAX_CONTEXT_BYTES && len(pack) > 0 {
            drop(pack, 1);
            if !pack.truncated.iter().any(|t| t == name) {
                pack.truncated.push(name.to_string());
            }
        }
        if size(pack) <= MAX_CONTEXT_BYTES {
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Arms and fusion
// ---------------------------------------------------------------------------

/// Which retrieval arm produced a hit. This is the auditability half of what
/// replaced "no embedding model enters the product": a reader can always tell
/// what KIND of evidence they are looking at.
///
/// The trust ordering is real and is stated in the retrieval contract:
/// - `Node` — **curated**. A human accepted this class. It outranks everything.
/// - `Note` — the user's own margin words. Human-authored, quoted verbatim.
/// - `Lexical` — the terms are literally present.
/// - `Grep` — an exact string match, with no relevance claim beyond "it's here".
/// - `Semantic` — **associated**, not asserted. A vector said these are alike.
///   A `Semantic`-only hit must be verified before being stated as fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Arm {
    Node,
    Note,
    Lexical,
    Grep,
    Semantic,
}

impl Arm {
    pub fn as_str(self) -> &'static str {
        match self {
            Arm::Node => "node",
            Arm::Note => "note",
            Arm::Lexical => "lexical",
            Arm::Grep => "grep",
            Arm::Semantic => "semantic",
        }
    }
}

/// One arm's contribution to a hit: which arm, where it ranked, what it scored.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmHit {
    pub arm: Arm,
    pub rank: usize,
    pub score: f64,
}

/// Reciprocal Rank Fusion's smoothing constant. 60 is the value from the
/// original paper and it is not a tuning dial here: it flattens the difference
/// between rank 1 and rank 2 enough that one arm's confident-but-wrong top hit
/// cannot dominate three other arms' agreement.
pub const RRF_K: f64 = 60.0;

/// Fuse ranked lists into one ordering by Reciprocal Rank Fusion.
///
/// RRF over score-normalization deliberately: the arms' scores are not
/// commensurable — bm25 is unbounded and negative-is-better, cosine is [-1,1],
/// and a grep hit has no score at all. Ranks are the only thing they share.
///
/// Returns each key with the arms that found it, ordered by fused score.
pub fn rrf_fuse(lists: &[(Arm, Vec<(String, f64)>)]) -> Vec<(String, Vec<ArmHit>, f64)> {
    let mut fused: std::collections::HashMap<String, (Vec<ArmHit>, f64)> =
        std::collections::HashMap::new();
    for (arm, hits) in lists {
        for (rank, (key, score)) in hits.iter().enumerate() {
            let contribution = 1.0 / (RRF_K + (rank + 1) as f64);
            let e = fused.entry(key.clone()).or_insert_with(|| (Vec::new(), 0.0));
            e.0.push(ArmHit { arm: *arm, rank: rank + 1, score: *score });
            e.1 += contribution;
        }
    }
    let mut out: Vec<(String, Vec<ArmHit>, f64)> =
        fused.into_iter().map(|(k, (arms, s))| (k, arms, s)).collect();
    // Deterministic: fused score desc, then key — never wall-clock or hash order.
    out.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    out
}

/// Which arms ran and what each returned — so an empty result reads as "the
/// semantic index isn't built yet" rather than "you never thought about this".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmCoverage {
    pub arm: Arm,
    /// `true` when the arm ran at all. A `false` here is the honest third
    /// state: absent, not empty.
    pub ran: bool,
    pub hits: usize,
    /// Why it did not run, when it did not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub absent_because: Option<String>,
}

// ---------------------------------------------------------------------------
// Inline prefetch rendering (one-turn Ask)
// ---------------------------------------------------------------------------

/// Byte ceiling for the prefetched-evidence block baked into an Ask prompt.
/// Sized against `classmem::CATALOG_SNAPSHOT_MAX_BYTES`, which rides in the
/// same prompt: prototyped over the live pack (`q=browser&limit=8`, 400-char
/// bodies, one line per link) the render came to ~6 KB, so 12 KB is headroom
/// rather than a target.
pub const INLINE_PACK_MAX_BYTES: usize = 12_000;
/// Hits per arm in a prefetch — deliberately below `ANSWER_PACK_LIMIT`. The
/// prefetch is a first look, not the whole record; the agent can still curl for
/// more, and the block tells it when that is worth doing.
pub const INLINE_PACK_LIMIT: i64 = 8;
/// Per-hit body window in the inline render, against the DB layer's 4,000. Eight
/// hits at 4,000 would be the whole budget spent on one arm.
pub const INLINE_BODY_CHARS: usize = 400;

/// Render an answer pack as the compact evidence block that rides inside an Ask
/// prompt, or `None` when there is nothing honest to say.
///
/// **`None` is a real answer here.** An empty block is strictly worse than
/// silence: it reads to the model as "the record was searched and is empty",
/// which is a claim about the user's history rather than about the query. So a
/// query with no terms ("what can you do?") and a pack where every arm came
/// back empty both render nothing at all, and the agent falls through to its
/// normal retrieval — which is exactly today's behaviour, i.e. the downside of
/// a prefetch miss is bounded at the status quo.
///
/// The block is **honest about itself**, and that is what makes the escape
/// hatch safe. It names the terms that were searched, the basis on which a node
/// resolved, and any list that was trimmed — so the model can tell "the record
/// is empty on this" from "the prefetch looked in the wrong place", and knows
/// when curling is worth a turn. Without that distinction a prefetch is just a
/// confident way to be wrong.
pub fn render_answer_pack_block(
    pack: &AnswerPack,
    plan: Option<&FtsPlan>,
    max_bytes: usize,
) -> Option<String> {
    let terms: Vec<String> = plan.map(|p| p.terms.clone()).unwrap_or_default();
    if terms.is_empty() && plan.map(|p| p.phrases.is_empty()).unwrap_or(true) {
        return None;
    }
    let empty = pack.node.is_none()
        && pack.notes.is_empty()
        && pack.prompt_hits.is_empty()
        && pack.browse_hits.is_empty()
        && pack.grep_hits.is_empty();
    if empty {
        return None;
    }

    let mut out = String::with_capacity(2048);
    out.push_str(&format!(
        "PREFETCHED EVIDENCE — assembled server-side from your question at seq {}.\n",
        pack.head_seq
    ));
    out.push_str(&format!("Searched: {}.\n", terms.join(", ")));
    if let Some(node) = &pack.node {
        // Say WHY it resolved. "Resolved: [[X]]" alone is an assertion; naming
        // the term that matched lets the model notice a wrong turn.
        let basis = terms
            .iter()
            .find(|t| node.node.title.to_lowercase().contains(t.as_str()))
            .map(|t| format!(" (matched \"{t}\" in the title)"))
            .unwrap_or_default();
        out.push_str(&format!("Resolved: [[{}]]{basis}.\n", node.node.title));
    } else {
        out.push_str("Resolved: no class matched — the lexical evidence below still stands.\n");
    }
    if !pack.truncated.is_empty() {
        out.push_str(&format!("TRIMMED: {}.\n", pack.truncated.join(", ")));
    }
    out.push_str(
        "If this answers the question, ANSWER — do not curl.\n\
         Curl the answer-pack ONLY when this block is empty on the subject you need, names \
         a node you want to descend into, or says it was TRIMMED.\n\n",
    );

    // The user's own words lead, exactly as in the pack itself.
    if !pack.notes.is_empty() {
        out.push_str("YOUR NOTES (human-authored — quote verbatim):\n");
        for n in &pack.notes {
            let star = if n.starred { "★ " } else { "" };
            out.push_str(&format!(
                "- {star}#{} {}\n",
                n.seq.unwrap_or(0),
                clip_line(&n.text, INLINE_BODY_CHARS)
            ));
        }
        out.push('\n');
    }
    if let Some(node) = &pack.node {
        if !node.children.is_empty() {
            let kids: Vec<&str> = node.children.iter().map(|c| c.title.as_str()).collect();
            out.push_str(&format!("Children of [[{}]]: {}\n\n", node.node.title, kids.join(" · ")));
        }
        if !node.links.is_empty() {
            out.push_str("FILED UNDER IT:\n");
            for l in &node.links {
                let sup = l
                    .superseded_by
                    .map(|s| format!(" [superseded by #{s}]"))
                    .unwrap_or_default();
                out.push_str(&format!(
                    "- #{} {}{sup}\n",
                    l.link.target_id,
                    clip_line(l.label.as_deref().unwrap_or("(no preview)"), 160)
                ));
            }
            out.push('\n');
        }
        if !node.observations.is_empty() {
            out.push_str("OBSERVATIONS (patterns, not facts — label them as such):\n");
            for o in &node.observations {
                out.push_str(&format!("- {}\n", clip_line(&o.summary, 200)));
            }
            out.push('\n');
        }
    }
    if !pack.prompt_hits.is_empty() {
        out.push_str("PROMPTS:\n");
        for h in &pack.prompt_hits {
            let sup = h
                .superseded_by
                .map(|s| format!(" [superseded by #{s}]"))
                .unwrap_or_default();
            let dupes = if h.duplicate_of.is_empty() {
                String::new()
            } else {
                format!(" [+{} near-identical]", h.duplicate_of.len())
            };
            // Name the arms. A hit two arms found is stronger evidence than one
            // either found alone, and a `semantic`-only hit is *associated*
            // rather than asserted — the reader can only weigh that if it says.
            let arms = if h.arms.is_empty() {
                String::new()
            } else {
                format!(
                    " ({})",
                    h.arms.iter().map(|a| a.arm.as_str()).collect::<Vec<_>>().join("+")
                )
            };
            out.push_str(&format!(
                "- #{}{sup}{dupes}{arms} {}\n",
                h.item.seq,
                clip_line(h.item.body.as_deref().unwrap_or(""), INLINE_BODY_CHARS)
            ));
        }
        out.push('\n');
    }
    if !pack.browse_hits.is_empty() {
        out.push_str("PAGES:\n");
        for b in &pack.browse_hits {
            out.push_str(&format!(
                "- #{} {} — {}\n",
                b.seq.unwrap_or(0),
                clip_line(b.title.as_deref().unwrap_or(""), 100),
                b.url
            ));
        }
        out.push('\n');
    }
    if !pack.grep_hits.is_empty() {
        out.push_str("LITERAL MATCHES:\n");
        for g in &pack.grep_hits {
            out.push_str(&format!(
                "- #{} {} {}\n",
                g.seq.unwrap_or(0),
                g.label,
                clip_line(&g.excerpt, 160)
            ));
        }
        out.push('\n');
    }

    // Clip at a line boundary, and SAY the block was clipped — a silently
    // truncated evidence block is the same lie as a silently truncated pack.
    if out.len() > max_bytes {
        let cut = out
            .char_indices()
            .take_while(|(i, _)| *i < max_bytes.saturating_sub(80))
            .map(|(i, _)| i)
            .last()
            .unwrap_or(0);
        let cut = out[..cut].rfind('\n').unwrap_or(cut);
        out.truncate(cut);
        out.push_str("\n[prefetch clipped to fit — curl the answer-pack for the rest]\n");
    }
    Some(out)
}

/// One line, newlines flattened, clipped with an ellipsis.
pub fn clip_line(s: &str, max: usize) -> String {
    let one = s.replace('\n', " ");
    if one.chars().count() <= max {
        one
    } else {
        one.chars().take(max).collect::<String>() + "…"
    }
}

/// The ticker line for a prefetched turn. `retrieval_status_label` narrates
/// curls, and a prefetched turn makes none — so without this the surface would
/// sit silent through the one part of the turn that used to show progress.
///
/// It reports a RESULT where the old ticker reported an ACTIVITY: "read
/// Embedded browser + 16 items…" rather than "searching your memory…".
pub fn prefetch_status_label(node: Option<&str>, hits: usize) -> String {
    match (node, hits) {
        (Some(title), 0) => format!("read {title}…"),
        (Some(title), n) => format!("read {title} + {n} items…"),
        (None, 0) => "nothing matched — asking anyway…".to_string(),
        (None, n) => format!("read {n} items…"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ticker reports a RESULT where the old one reported an ACTIVITY.
    #[test]
    fn prefetch_status_reports_what_was_read() {
        assert_eq!(
            prefetch_status_label(Some("Embedded browser"), 16),
            "read Embedded browser + 16 items…"
        );
        assert_eq!(prefetch_status_label(Some("Voice agent"), 0), "read Voice agent…");
        assert_eq!(prefetch_status_label(None, 4), "read 4 items…");
        // The honest empty case — never a silent ticker.
        assert_eq!(prefetch_status_label(None, 0), "nothing matched — asking anyway…");
    }

    /// RRF fuses by RANK, not by score — the arms' scores are not
    /// commensurable (bm25 is unbounded and negative-is-better, cosine is
    /// [-1,1], grep has no score at all), so ranks are the only shared unit.
    #[test]
    fn rrf_rewards_agreement_between_arms() {
        let lexical = vec![("a".to_string(), 9.0), ("b".to_string(), 8.0), ("c".to_string(), 7.0)];
        let semantic = vec![("c".to_string(), 0.91), ("a".to_string(), 0.88)];
        let fused = rrf_fuse(&[(Arm::Lexical, lexical), (Arm::Semantic, semantic)]);

        // `a` is rank 1 and rank 2 — found by both, so it leads.
        assert_eq!(fused[0].0, "a");
        assert_eq!(fused[0].1.len(), 2, "both arms are recorded on the hit");
        // `c` (ranks 3 and 1) beats `b` (rank 2 in one arm only): agreement
        // across arms outweighs a better position in one of them.
        let pos = |k: &str| fused.iter().position(|(x, _, _)| x == k).unwrap();
        assert!(pos("c") < pos("b"), "two arms agreeing beats one arm ranking higher");

        // Every hit names its arms with rank and score, so a `semantic`-only
        // hit is visibly *associated* rather than asserted.
        let b = &fused[pos("b")].1;
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].arm, Arm::Lexical);
        assert_eq!(b[0].rank, 2);

        // Deterministic on ties — never hash order.
        let tie = rrf_fuse(&[
            (Arm::Lexical, vec![("z".into(), 1.0)]),
            (Arm::Semantic, vec![("y".into(), 1.0)]),
        ]);
        assert_eq!(tie.iter().map(|(k, _, _)| k.as_str()).collect::<Vec<_>>(), ["y", "z"]);
        assert!(rrf_fuse(&[]).is_empty());
    }

    /// The budget may starve nothing. The old rule dropped whole lists in a
    /// fixed order, so a bloated `promptHits` cost the user EVERY page before a
    /// single prompt was touched — which is what the live probe showed
    /// (`browseHits: 0`, `truncated: [browseHits, promptHits]`).
    #[test]
    fn budget_keeps_one_hit_per_arm() {
        let filler = "x".repeat(6_000);
        let mut pack = AnswerPack {
            head_seq: 1,
            query: Some("q".into()),
            node: None,
            matched_nodes: Vec::new(),
            notes: (0..30)
                .map(|i| UserNote {
                    id: i,
                    seq: Some(i),
                    target_kind: "none".into(),
                    target_id: None,
                    text: filler.clone(),
                    starred: false,
                    created_at: 0,
                    updated_at: 0,
                })
                .collect(),
            prompt_hits: (0..30)
                .map(|i| PackPromptHit {
                    item: LakeItem {
                        seq: i,
                        ts: 0,
                        kind: "prompt".into(),
                        ref_kind: None,
                        ref_id: None,
                        session_id: None,
                        surface: None,
                        origin: None,
                        role: None,
                        mission_id: None,
                        project_path: None,
                        body: Some(filler.clone()),
                        thread_kind: None,
                        thread_id: None,
                        parent_session_id: None,
                        model: None,
                    },
                    superseded_by: None,
                    duplicate_of: Vec::new(),
                    stage: "and".into(),
                    arms: Vec::new(),
                })
                .collect(),
            browse_hits: (0..30)
                .map(|i| crate::types::BrowseHit {
                    id: i,
                    seq: Some(i),
                    ts: 0,
                    url: format!("https://example.com/{i}"),
                    title: Some(filler.clone()),
                    snippet: filler.clone(),
                    score: 0.0,
                    stage: "and".into(),
                    shot_key: None,
                    caption: None,
                })
                .collect(),
            grep_hits: Vec::new(),
            arm_coverage: Vec::new(),
            truncated: Vec::new(),
        };
        enforce_pack_budget(&mut pack);

        let bytes = serde_json::to_vec(&pack).unwrap().len();
        assert!(bytes <= MAX_CONTEXT_BYTES, "{bytes} over budget");
        assert!(!pack.browse_hits.is_empty(), "pages must not be erased outright");
        assert!(!pack.prompt_hits.is_empty(), "prompts must not be erased outright");
        assert!(!pack.notes.is_empty(), "the user's own words least of all");
        // …and every arm that lost something says so.
        for arm in ["browseHits", "promptHits"] {
            assert!(
                pack.truncated.iter().any(|t| t == arm),
                "{arm} was trimmed and must report it: {:?}",
                pack.truncated
            );
        }
    }
}
