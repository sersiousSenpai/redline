// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The semantic arm's pure vocabulary: text chunking and int8 vector
//! quantization / cosine / packing. No provider, no store — the same code an
//! embedder produces into and a search reads from. Lifted from Redline's
//! `embed.rs` in Session A3 of the Polis extraction.

/// Target characters per chunk. Small on purpose: `NLContextualEmbedding` caps
/// at 256 tokens, and a chunk that overflows the cap is silently truncated
/// rather than rejected — the failure mode is a vector that quietly describes
/// only the opening of the text.
pub const CHUNK_TARGET: usize = 800;

/// Hard ceiling before a hard cut.
pub const CHUNK_MAX: usize = 1_200;

/// Overlap between adjacent chunks, so a sentence spanning a boundary is whole
/// in at least one of them.
pub const CHUNK_OVERLAP: usize = 150;

/// Chunk 0 is ALWAYS the opening of the text, whatever the paragraph structure
/// says. Same insight as `fts_head`: a 6 KB prompt states its ask in its first
/// paragraph, and without a dedicated chunk for it that question is diluted
/// across a mean-pooled vector of the whole thing.
pub const OPENING_CHARS: usize = 400;

/// The dimensionality both Apple providers return.
pub const DIM: usize = 512;

/// One chunk of a source text, with the offsets it came from so a hit can be
/// highlighted back on the original.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub ix: i64,
    pub char_start: i64,
    pub char_len: i64,
    pub text: String,
}

/// Split text into embeddable chunks: paragraph boundaries first, then
/// sentences, then a hard cut. Never splits a fenced code block that fits.
pub fn chunk_text(text: &str) -> Vec<Chunk> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();

    // Chunk 0: the opening, always.
    let opening_len = OPENING_CHARS.min(chars.len());
    out.push(Chunk {
        ix: 0,
        char_start: 0,
        char_len: opening_len as i64,
        text: chars[..opening_len].iter().collect(),
    });
    if chars.len() <= OPENING_CHARS {
        return out;
    }

    let mut start = 0usize;
    while start < chars.len() {
        let hard_end = (start + CHUNK_MAX).min(chars.len());
        let target_end = (start + CHUNK_TARGET).min(chars.len());
        let end = if hard_end == chars.len() {
            chars.len()
        } else {
            // Prefer a paragraph break, then a sentence end, then the hard cut.
            // A fenced block that fits is never split: if the window opens a
            // fence and closes it before `hard_end`, cut after the close.
            find_break(&chars, start, target_end, hard_end)
        };
        let slice: String = chars[start..end].iter().collect();
        if !slice.trim().is_empty() {
            out.push(Chunk {
                ix: out.len() as i64,
                char_start: start as i64,
                char_len: (end - start) as i64,
                text: slice,
            });
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP).max(start + 1);
    }
    out
}

/// Choose a cut point in `[target, hard]`, preferring structure over position.
fn find_break(chars: &[char], start: usize, target: usize, hard: usize) -> usize {
    // A fence that opens inside this window and closes before the hard cut
    // takes precedence — splitting a code block produces two useless vectors.
    let window: String = chars[start..hard].iter().collect();
    if let Some(open) = window.find("```") {
        if let Some(close) = window[open + 3..].find("```") {
            let after = start + open + 3 + close + 3;
            if after > target && after <= hard {
                return after;
            }
        }
    }
    // Paragraph break at or after the target.
    for i in target..hard.saturating_sub(1) {
        if chars[i] == '\n' && chars[i + 1] == '\n' {
            return i + 2;
        }
    }
    // Sentence end.
    for i in target..hard {
        if matches!(chars[i], '.' | '!' | '?')
            && chars.get(i + 1).is_none_or(|c| c.is_whitespace())
        {
            return i + 1;
        }
    }
    hard
}

/// A quantized, L2-normalized embedding.
///
/// **int8, not f32**, and the arithmetic is the reason: recall loss is under 1%
/// at 512 dimensions while the storage drops from 2 KB to 516 B per chunk —
/// today's ~3,000 chunks are 1.6 MB instead of 6.3 MB. On a derived index that
/// can be rebuilt at any time, that is a free trade.
#[derive(Debug, Clone, PartialEq)]
pub struct QVec {
    pub scale: f32,
    pub bytes: Vec<i8>,
}

/// L2-normalize then quantize to int8 with a per-vector scale.
pub fn quantize(v: &[f32]) -> QVec {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    let inv = if norm > f32::EPSILON { 1.0 / norm } else { 0.0 };
    let unit: Vec<f32> = v.iter().map(|x| x * inv).collect();
    let peak = unit.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    let scale = if peak > f32::EPSILON { peak / 127.0 } else { 1.0 };
    QVec {
        scale,
        bytes: unit
            .iter()
            .map(|x| (x / scale).round().clamp(-127.0, 127.0) as i8)
            .collect(),
    }
}

/// Cosine similarity between two quantized vectors.
///
/// Both were unit-normalized before quantization, so the dot product IS the
/// cosine; the per-vector scales fold back in as one multiply at the end. The
/// inner loop is `i8 → i32`, which is what keeps brute force viable.
pub fn cosine(a: &QVec, b: &QVec) -> f32 {
    if a.bytes.len() != b.bytes.len() {
        return 0.0;
    }
    let dot: i32 = a
        .bytes
        .iter()
        .zip(b.bytes.iter())
        .map(|(x, y)| *x as i32 * *y as i32)
        .sum();
    dot as f32 * a.scale * b.scale
}

/// Pack a quantized vector for storage as a BLOB.
pub fn pack(q: &QVec) -> Vec<u8> {
    q.bytes.iter().map(|b| *b as u8).collect()
}

/// Unpack a stored BLOB.
pub fn unpack(blob: &[u8], scale: f32) -> QVec {
    QVec {
        scale,
        bytes: blob.iter().map(|b| *b as i8).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_zero_is_always_the_opening() {
        let text = format!("THE ASK: what did I decide?\n\n{}", "filler ".repeat(500));
        let chunks = chunk_text(&text);
        assert_eq!(chunks[0].ix, 0);
        assert_eq!(chunks[0].char_start, 0);
        assert!(chunks[0].text.starts_with("THE ASK"));
        assert_eq!(chunks[0].char_len, OPENING_CHARS as i64);
        // …and it does not consume the rest: the body is chunked too.
        assert!(chunks.len() > 1);
    }

    #[test]
    fn short_text_is_one_chunk_with_no_padding() {
        let chunks = chunk_text("a short prompt");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "a short prompt");
        assert_eq!(chunks[0].char_len, 14);
        assert!(chunk_text("").is_empty());
    }

    #[test]
    fn chunks_overlap_and_stay_under_the_ceiling() {
        let text: String = (0..400).map(|i| format!("sentence number {i}. ")).collect();
        let chunks = chunk_text(&text);
        assert!(chunks.len() > 3);
        for c in &chunks {
            assert!(
                c.char_len <= CHUNK_MAX as i64,
                "chunk {} is {} chars",
                c.ix,
                c.char_len
            );
        }
        // Body chunks (past the opening) overlap their predecessor.
        for w in chunks[1..].windows(2) {
            let prev_end = w[0].char_start + w[0].char_len;
            assert!(w[1].char_start < prev_end, "chunks must overlap");
        }
    }

    /// A fenced block that fits is never split — two halves of a code block
    /// embed to two vectors that describe neither.
    #[test]
    fn a_fenced_block_that_fits_is_kept_whole() {
        let pre = "x".repeat(700);
        let code = format!("```rust\n{}\n```", "let x = 1;\n".repeat(20));
        let text = format!("{pre}\n\n{code}\n\ntrailing prose {}", "y".repeat(600));
        let chunks = chunk_text(&text);
        let holding = chunks
            .iter()
            .skip(1)
            .find(|c| c.text.contains("```rust"))
            .expect("some chunk opens the fence");
        assert!(
            holding.text.matches("```").count() >= 2,
            "the chunk that opens a fence must also close it:\n{}",
            holding.text
        );
    }

    #[test]
    fn quantization_round_trips_within_tolerance() {
        let v: Vec<f32> = (0..DIM).map(|i| ((i as f32) * 0.017).sin()).collect();
        let q = quantize(&v);
        assert_eq!(q.bytes.len(), DIM);
        // A vector is maximally similar to itself.
        assert!((cosine(&q, &q) - 1.0).abs() < 0.02, "self-cosine {}", cosine(&q, &q));
        // Storage: one byte per dimension plus the scale.
        assert_eq!(pack(&q).len(), DIM);
        assert_eq!(unpack(&pack(&q), q.scale), q);
    }

    #[test]
    fn cosine_orders_similar_above_dissimilar() {
        let a: Vec<f32> = (0..DIM).map(|i| (i as f32 * 0.01).sin()).collect();
        // `b` is `a` with noise; `c` is unrelated.
        let b: Vec<f32> = a.iter().enumerate().map(|(i, x)| x + (i as f32 * 0.3).cos() * 0.05).collect();
        let c: Vec<f32> = (0..DIM).map(|i| (i as f32 * 0.31).cos()).collect();
        let (qa, qb, qc) = (quantize(&a), quantize(&b), quantize(&c));
        assert!(
            cosine(&qa, &qb) > cosine(&qa, &qc),
            "near {} vs far {}",
            cosine(&qa, &qb),
            cosine(&qa, &qc)
        );
        // Mismatched dimensions score zero rather than panicking.
        assert_eq!(cosine(&qa, &quantize(&[1.0, 2.0])), 0.0);
    }
}
