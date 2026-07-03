// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Merge a diff line's three render layers — syntax tokens (`highlight_diff`),
//! word-diff change spans, and search matches — into one flat span list. Each
//! layer is converted to char-offset ranges, the text is split at the union of
//! all boundaries, and every slice carries whatever the layers say about it.
//! Pure and DOM-free (flattenDiff/wordDiff testing discipline); offsets are JS
//! code units throughout, so slicing is consistent for multi-byte text as long
//! as each layer's spans reconstruct the same string.

import type { WordSpan } from "./wordDiff";

/** One `highlight_diff` token run: `c` = hljs-* class, `t` = text. */
export interface HlToken {
  c?: string;
  t: string;
}

/** A search hit within the line, as char offsets. */
export interface MatchRange {
  start: number;
  end: number;
  active: boolean;
}

/** One renderable slice of the line. */
export interface RenderSpan {
  text: string;
  /** hljs-* class from the syntax layer. */
  cls?: string;
  /** Word-diff change tint (the row's side decides add vs del). */
  word?: "add" | "del";
  /** Search decoration; `active` is the focused match. */
  match?: "hit" | "active";
}

interface Range<T> {
  start: number;
  end: number;
  value: T;
}

/** Accumulate consecutive texts into ranges. Clamped to `len` so a layer that
 *  disagrees with the line text can never produce out-of-bounds slices. */
function rangesOf<S>(
  parts: S[],
  textOf: (s: S) => string,
  len: number,
): Range<S>[] {
  const out: Range<S>[] = [];
  let at = 0;
  for (const p of parts) {
    const n = textOf(p).length;
    const start = Math.min(at, len);
    const end = Math.min(at + n, len);
    if (end > start) out.push({ start, end, value: p });
    at += n;
  }
  return out;
}

function valueAt<S>(ranges: Range<S>[], pos: number): S | undefined {
  // Layers are small (a handful of runs per line) — linear scan is fine.
  for (const r of ranges) {
    if (pos >= r.start && pos < r.end) return r.value;
  }
  return undefined;
}

/**
 * Compose the line's layers into render spans.
 * - `tokens`: syntax runs for this line (`null` = not highlighted).
 * - `word`: word-diff spans for this line plus which tint its side takes
 *   (`null` = not a paired change line).
 * - `matches`: search hits (empty array = none).
 * Empty text yields `[]` (the row renders nothing, height comes from CSS).
 */
export function composeLineSpans(
  text: string,
  tokens: HlToken[] | null,
  word: { spans: WordSpan[]; kind: "add" | "del" } | null,
  matches: MatchRange[],
): RenderSpan[] {
  if (text.length === 0) return [];

  const tokenRanges = tokens ? rangesOf(tokens, (t) => t.t, text.length) : [];
  const wordRanges = word
    ? rangesOf(word.spans, (s) => s.text, text.length).filter((r) => r.value.changed)
    : [];
  const matchRanges = matches.filter((m) => m.end > m.start && m.start < text.length);

  // Union of all layer boundaries, plus the line's own ends.
  const cuts = new Set<number>([0, text.length]);
  for (const r of tokenRanges) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  for (const r of wordRanges) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  for (const m of matchRanges) {
    cuts.add(Math.max(0, m.start));
    cuts.add(Math.min(text.length, m.end));
  }
  const bounds = [...cuts].sort((a, b) => a - b);

  const out: RenderSpan[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end <= start) continue;
    const span: RenderSpan = { text: text.slice(start, end) };
    const tok = valueAt(tokenRanges, start);
    if (tok?.c) span.cls = tok.c;
    if (valueAt(wordRanges, start)) span.word = word!.kind;
    const hit = matchRanges.find((m) => start >= m.start && start < m.end);
    if (hit) span.match = hit.active ? "active" : "hit";
    // Coalesce with the previous span when nothing differs — fewer DOM nodes.
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.cls === span.cls &&
      prev.word === span.word &&
      prev.match === span.match
    ) {
      prev.text += span.text;
    } else {
      out.push(span);
    }
  }
  return out;
}
