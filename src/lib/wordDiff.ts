// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Intra-line ("word-level") diff for paired del/add lines in the review pane.
//! Pure and DOM-free: `pairHunkLines` decides which deleted line lines up with
//! which added line inside a hunk (git pairs a run of `-` lines with the run of
//! `+` lines that follows, positionally), and `wordDiff` marks the changed
//! token spans between the two texts via an LCS over word/whitespace tokens.
//! Deliberately tiny and unit-tested, since it's the most visible readability
//! feature of a diff view.

import type { DiffHunk } from "../types";

/** One rendered span of a line: `changed` spans get the highlight tint. */
export interface WordSpan {
  text: string;
  changed: boolean;
}

/** Tokenize into words / whitespace / single punctuation, so the LCS aligns on
 *  meaningful units and never splits inside a word. */
export function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) ?? [];
}

/** Longest-common-subsequence keep-flags for `a` against `b`. O(n·m); callers
 *  cap input size (diff lines are short — a pathological minified line falls
 *  back to whole-line highlight). */
function lcsKeep(a: string[], b: string[]): [boolean[], boolean[]] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keepA[i] = true;
      keepB[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return [keepA, keepB];
}

/** Merge consecutive tokens with the same changed-flag into one span. */
function toSpans(tokens: string[], keep: boolean[]): WordSpan[] {
  const spans: WordSpan[] = [];
  tokens.forEach((text, idx) => {
    const changed = !keep[idx];
    const last = spans[spans.length - 1];
    if (last && last.changed === changed) {
      last.text += text;
    } else {
      spans.push({ text, changed });
    }
  });
  return spans;
}

/** Token cap above which we skip the LCS and mark the whole line changed —
 *  keeps a minified-JS line from costing O(n²) on the render path. */
const MAX_TOKENS = 300;

/** Word-level spans for a deleted line vs its paired added line. Both results
 *  cover their full input text; `changed` marks what differs. */
export function wordDiff(
  delText: string,
  addText: string,
): { del: WordSpan[]; add: WordSpan[] } {
  const a = tokenize(delText);
  const b = tokenize(addText);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return {
      del: delText ? [{ text: delText, changed: true }] : [],
      add: addText ? [{ text: addText, changed: true }] : [],
    };
  }
  const [keepA, keepB] = lcsKeep(a, b);
  return { del: toSpans(a, keepA), add: toSpans(b, keepB) };
}

/** Pair up del/add lines inside a hunk the way git presents them: a run of
 *  consecutive `-` lines followed by a run of `+` lines pairs positionally
 *  (1st del ↔ 1st add, …). Returns hunk-line-index → paired hunk-line-index
 *  for every line that has a partner; unpaired lines get whole-line tint. */
export function pairHunkLines(hunk: DiffHunk): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  const lines = hunk.lines;
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i].kind === "del") i++;
    const addStart = i;
    while (i < lines.length && lines[i].kind === "add") i++;
    const dels = addStart - delStart;
    const adds = i - addStart;
    for (let k = 0; k < Math.min(dels, adds); k++) {
      pairs.set(delStart + k, addStart + k);
      pairs.set(addStart + k, delStart + k);
    }
  }
  return pairs;
}
