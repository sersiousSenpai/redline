// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The deterministic gist — compaction's no-model floor. Keeps the head AND the
//! tail of a cold body and records what was released, so compaction never
//! hard-depends on a summarizer being installed.

/// Deterministic-fallback gist keeps this many leading characters…
pub const GIST_HEAD_CHARS: usize = 200;
/// …and this many trailing ones. A prompt states its ask at the top and lands
/// its decision at the bottom; a pure head window keeps the first and throws the
/// second away, which is why 47% of surviving gists read as an opening sentence
/// and nothing else. Head+tail costs 80 characters and keeps both ends.
pub const GIST_TAIL_CHARS: usize = 120;

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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn deterministic_gist_marks_reclaimed_bytes() {
        let body = "word ".repeat(200); // 1000 bytes
        let g = deterministic_gist(&body);
        assert!(g.contains("[compacted 1000 bytes]"));
        assert!(g.chars().count() < body.chars().count());
    }
}
