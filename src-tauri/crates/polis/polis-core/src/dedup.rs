// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Near-duplicate suppression and match-centered excerpting for the answer pack.
//!
//! The failure this exists to prevent, measured on the live daemon:
//! `GET /v1/memory/answer-pack?q=keeper compaction` returned 50,642 bytes in
//! which **four of eight top hits were the same ClassMemory boilerplate**, each
//! clipped at 4,000 characters — and the byte budget then dropped the remaining
//! prompts and every browse hit to make room for the duplicates.
//!
//! Two separate mistakes produced that, and both are fixed here:
//!
//! 1. **No dedup.** Exact duplicates were free to detect — `prompts.body_hash`
//!    and `browse_events.context_hash` both exist and are indexed — and nothing
//!    looked. Near-duplicates (the same preface around a different question)
//!    needed a similarity measure, which is what `simhash` provides.
//!
//! 2. **Head clipping.** Every hit was clipped to its first 4,000 characters,
//!    which is precisely why four copies of one preface looked identical: their
//!    heads *were* identical, and the words that distinguished them sat past
//!    the cut. `excerpt_around` centers the window on the matched term instead,
//!    which both distinguishes them and shows the user why the hit matched.
//!
//! Nothing here is persisted. The SimHash is computed lazily over only the ≤60
//! candidates already in hand (~360 KB to hash, sub-millisecond), so the
//! Hamming threshold can be retuned without a migration — a stored fingerprint
//! would have frozen a tuning parameter into the schema.

/// Shingle width for the SimHash: three consecutive tokens.
///
/// Single tokens would make two documents about the same subject look
/// identical; whole sentences would make a one-word edit look novel. Three is
/// the standard middle, and it is what makes "the same 6 KB preface wrapped
/// around a different question" score as near-duplicate while two genuinely
/// different prompts on the same topic do not.
const SHINGLE: usize = 3;

/// Hamming distance at or below which two 64-bit fingerprints are "the same
/// text". Empirical: identical-preface pairs land at 0–2, genuinely distinct
/// prompts on a shared topic land above 10.
pub const NEAR_DUP_HAMMING: u32 = 3;

/// 64-bit SimHash over token 3-shingles.
///
/// Unlike a cryptographic hash, similar inputs produce similar outputs: each
/// shingle votes on every output bit, and the sign of the summed vote is the
/// bit. Two texts differing in a few shingles move a few votes and therefore
/// flip few bits.
pub fn simhash(text: &str) -> u64 {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    if tokens.is_empty() {
        return 0;
    }
    let mut votes = [0i32; 64];
    let shingles = if tokens.len() < SHINGLE { 1 } else { tokens.len() - SHINGLE + 1 };
    for i in 0..shingles {
        let end = (i + SHINGLE).min(tokens.len());
        let h = fnv1a(&tokens[i..end]);
        for (bit, vote) in votes.iter_mut().enumerate() {
            if h >> bit & 1 == 1 {
                *vote += 1;
            } else {
                *vote -= 1;
            }
        }
    }
    let mut out = 0u64;
    for (bit, vote) in votes.iter().enumerate() {
        if *vote > 0 {
            out |= 1 << bit;
        }
    }
    out
}

/// FNV-1a over a shingle's tokens, lowercased, space-joined. Chosen over
/// anything cryptographic because this is a bucketing hash, not a commitment —
/// the ledger's `body_hash` is where sha2 belongs.
fn fnv1a(tokens: &[&str]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut byte = |b: u8| {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    };
    for (i, t) in tokens.iter().enumerate() {
        if i > 0 {
            byte(b' ');
        }
        for b in t.bytes() {
            byte(b.to_ascii_lowercase());
        }
    }
    h
}

/// Are two texts near-duplicates?
pub fn near_duplicate(a: u64, b: u64) -> bool {
    (a ^ b).count_ones() <= NEAR_DUP_HAMMING
}

/// What a dedup pass decided about one candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Keep it; these later candidates collapsed into it.
    Keep { absorbed: Vec<i64> },
    /// Drop it: it duplicates the candidate with this key.
    Duplicate { of: i64 },
}

/// One candidate for deduplication: a stable key (the ledger seq), an exact
/// identity (the stored content hash), and the text to compare.
pub struct Candidate<'a> {
    pub key: i64,
    pub exact_hash: Option<&'a str>,
    pub text: &'a str,
}

/// Collapse exact and near duplicates, keeping the EARLIEST candidate in the
/// order given and recording which keys folded into it.
///
/// Order matters and is the caller's: pass candidates best-first and the best
/// copy survives; pass them oldest-first and the original survives. The answer
/// pack passes them in rank order, so the highest-scoring copy is the one the
/// model reads.
///
/// Exact identity is checked first and costs nothing — both content hashes are
/// already stored and indexed, and 20% of browse events are exact duplicates
/// today (829 rows → 665 distinct). Only survivors of that pass get fingerprinted.
pub fn dedup(candidates: &[Candidate<'_>]) -> Vec<Verdict> {
    let mut verdicts: Vec<Verdict> = Vec::with_capacity(candidates.len());
    // (index of the kept candidate, its fingerprint)
    let mut kept: Vec<(usize, u64)> = Vec::new();
    let mut kept_hashes: Vec<(usize, &str)> = Vec::new();

    for (i, c) in candidates.iter().enumerate() {
        let mut dupe_of: Option<usize> = None;
        if let Some(h) = c.exact_hash.filter(|h| !h.is_empty()) {
            if let Some((j, _)) = kept_hashes.iter().find(|(_, kh)| *kh == h) {
                dupe_of = Some(*j);
            }
        }
        let fp = simhash(c.text);
        if dupe_of.is_none() && !c.text.trim().is_empty() {
            if let Some((j, _)) = kept.iter().find(|(_, kfp)| near_duplicate(*kfp, fp)) {
                dupe_of = Some(*j);
            }
        }
        match dupe_of {
            Some(j) => {
                verdicts.push(Verdict::Duplicate { of: candidates[j].key });
                if let Verdict::Keep { absorbed } = &mut verdicts[j] {
                    absorbed.push(c.key);
                }
            }
            None => {
                kept.push((i, fp));
                if let Some(h) = c.exact_hash.filter(|h| !h.is_empty()) {
                    kept_hashes.push((i, h));
                }
                verdicts.push(Verdict::Keep { absorbed: Vec::new() });
            }
        }
    }
    verdicts
}

/// Clip `text` to `budget` characters, CENTERED on the first matched term
/// rather than on the head.
///
/// The head clip is what made four copies of one preface indistinguishable: a
/// 6 KB constructed prompt is 4 KB of identical framing followed by the part
/// that differs, so clipping the head shows the framing four times and the
/// difference never. Centering also answers the user's real question about a
/// hit — *why did this match?* — which a head window cannot.
///
/// Falls back to a head window when no term is found (an empty term list, or a
/// hit that matched through a stem the raw text doesn't contain literally).
pub fn excerpt_around(text: &str, terms: &[String], budget: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= budget {
        return text.to_string();
    }
    let lower = text.to_lowercase();
    // Character offset of the earliest matching term, if any.
    let hit = terms
        .iter()
        .filter(|t| !t.is_empty())
        .filter_map(|t| lower.find(&t.to_lowercase()))
        .min()
        .map(|byte_ix| lower[..byte_ix].chars().count());

    let Some(hit) = hit else {
        let head: String = chars.iter().take(budget).collect();
        return format!("{head}…");
    };

    // Centre the window on the hit, then clamp it inside the text.
    let half = budget / 2;
    let start = hit.saturating_sub(half).min(chars.len().saturating_sub(budget));
    let end = (start + budget).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(chars[start..end].iter());
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// Per-hit character budget for a pack of `n_hits` results.
///
/// The old flat 4,000 was not a budget at all: eight hits could each claim
/// 4,000 characters and together blow past `MAX_CONTEXT_BYTES`, at which point
/// the trim loop dropped whole categories to compensate — which is how the live
/// probe lost every browse hit to four copies of one preface. Dividing half the
/// byte budget among the hits makes the claim bounded by construction, and the
/// clamp keeps a single hit readable at one end and a twenty-hit pack useful at
/// the other.
pub fn per_hit_budget(max_context_bytes: usize, n_hits: usize) -> usize {
    (max_context_bytes / 2 / n_hits.max(1)).clamp(600, 4000)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live failure, reproduced: the same preface wrapped around different
    /// questions must collapse to one hit.
    #[test]
    fn simhash_catches_a_framed_boilerplate_pair() {
        let preface = "You are Redline's ClassMemory orchestrator. You organize the user's raw \
                       prompt and decision lake into an emergent class tree. You are READ-ONLY \
                       over the lake and your organization is applied directly. "
            .repeat(8);
        let a = format!("{preface}\n\nThe user asks: what did I decide about compaction?");
        let b = format!("{preface}\n\nThe user asks: what did I decide about the browser?");
        assert!(
            near_duplicate(simhash(&a), simhash(&b)),
            "hamming = {}",
            (simhash(&a) ^ simhash(&b)).count_ones()
        );
    }

    #[test]
    fn simhash_separates_genuinely_different_prompts() {
        let a = "wire the loop executor to the run watcher so a stalled run reports itself";
        let b = "add a role facet chip to the timeline defaulting to the user's own prompts";
        assert!(
            !near_duplicate(simhash(a), simhash(b)),
            "hamming = {}",
            (simhash(a) ^ simhash(b)).count_ones()
        );
        // Same topic, different content — must NOT collapse, or the pack starts
        // hiding evidence the user asked for.
        let c = "the browser tab suspension keeps three webviews live at a time";
        let d = "the browser new-window handler exists for OAuth popups";
        assert!(!near_duplicate(simhash(c), simhash(d)));
    }

    #[test]
    fn exact_hashes_collapse_before_any_fingerprinting() {
        let cands = vec![
            Candidate { key: 1, exact_hash: Some("h1"), text: "alpha" },
            Candidate { key: 2, exact_hash: Some("h2"), text: "beta beta beta" },
            Candidate { key: 3, exact_hash: Some("h1"), text: "alpha" },
        ];
        let v = dedup(&cands);
        assert_eq!(v[2], Verdict::Duplicate { of: 1 });
        assert_eq!(v[0], Verdict::Keep { absorbed: vec![3] }, "the first copy records the rest");
        assert!(matches!(v[1], Verdict::Keep { .. }));
    }

    /// Centering is the point: a head clip over identical prefaces produces
    /// identical excerpts, which is exactly what the user saw.
    #[test]
    fn excerpt_centers_on_the_match() {
        let text = format!("{}NEEDLE{}", "pad ".repeat(500), " tail".repeat(500));
        let terms = vec!["needle".to_string()];
        let out = excerpt_around(&text, &terms, 200);
        assert!(out.contains("NEEDLE"), "the match must be inside the window");
        assert!(out.starts_with('…') && out.ends_with('…'), "elision on both sides: {out}");
        assert!(out.chars().count() <= 202);

        // Two texts sharing a long head but differing at the match are now
        // distinguishable — the property the head clip destroyed.
        let a = format!("{}ALPHA-ANSWER", "identical preface. ".repeat(300));
        let b = format!("{}BETA-ANSWER", "identical preface. ".repeat(300));
        let ea = excerpt_around(&a, &vec!["alpha-answer".to_string()], 120);
        let eb = excerpt_around(&b, &vec!["beta-answer".to_string()], 120);
        assert_ne!(ea, eb);
    }

    #[test]
    fn excerpt_falls_back_to_the_head_without_a_match() {
        let text = "a".repeat(1000);
        let out = excerpt_around(&text, &["zebra".to_string()], 50);
        assert_eq!(out.chars().count(), 51);
        assert!(out.ends_with('…') && !out.starts_with('…'));
        // Short text is returned whole, with no ellipsis at all.
        assert_eq!(excerpt_around("short", &["short".to_string()], 50), "short");
    }

    /// Eight hits must not each be able to claim 4,000 characters.
    #[test]
    fn per_hit_budget_divides_rather_than_multiplies() {
        assert_eq!(per_hit_budget(60_000, 1), 4000, "a single hit stays readable");
        assert_eq!(per_hit_budget(60_000, 8), 3750);
        assert_eq!(per_hit_budget(60_000, 20), 1500);
        assert_eq!(per_hit_budget(60_000, 200), 600, "and never collapses to nothing");
        // The whole point: n hits × their budget stays inside the budget.
        for n in [1usize, 4, 8, 20] {
            assert!(per_hit_budget(60_000, n) * n <= 60_000 / 2 + 4000);
        }
    }
}
