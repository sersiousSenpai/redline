// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/**
 * Tiny in-house sentence segmenter for sub-block addressing (`.sN` axis).
 *
 * Split on end-of-sentence punctuation followed by whitespace and a capital
 * letter or opening quote / paren. A small abbreviation allow-list and a
 * code-span mask handle the obvious false-positive cases. Deterministic,
 * dependency-free, and intentionally narrow — the sub-block id resolver
 * tolerates wrong splits via its `charStart`/`charEnd` and `quotedText`
 * fallback tiers, so we trade exhaustive accuracy for predictability.
 */

const ABBREVS = new Set([
  "Mr.",
  "Mrs.",
  "Ms.",
  "Dr.",
  "Sr.",
  "Jr.",
  "St.",
  "vs.",
  "e.g.",
  "i.e.",
  "etc.",
  "Inc.",
  "Ltd.",
  "Co.",
  "Corp.",
  "No.",
  "Fig.",
  "Eq.",
  "p.",
  "pp.",
]);

/** Inclusive offsets of one sentence's run within the input string. */
export interface Sentence {
  start: number;
  end: number;
  text: string;
}

/** Mask inline backtick code spans with `\0` placeholders of the same byte
 *  length so split offsets translate back faithfully — and so `.` inside
 *  `foo.bar()` can't trigger a sentence boundary. */
function maskCodeSpans(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const tick = s.indexOf("`", i);
    if (tick === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, tick);
    const close = s.indexOf("`", tick + 1);
    if (close === -1) {
      out += s.slice(tick);
      break;
    }
    out += "\0".repeat(close - tick + 1);
    i = close + 1;
  }
  return out;
}

/** Split `text` into sentences. Always returns at least one sentence (the
 *  whole input) when `text.trim()` is non-empty; an empty / whitespace-only
 *  input returns an empty array. */
export function segmentSentences(text: string): Sentence[] {
  if (!text.trim()) return [];
  const masked = maskCodeSpans(text);
  const out: Sentence[] = [];
  let start = 0;
  let i = 0;
  while (i < masked.length) {
    const ch = masked[i];
    if (ch === "." || ch === "!" || ch === "?") {
      // Look ahead for whitespace + (capital | quote | paren). End-of-input
      // also closes a sentence.
      const afterPunct = i + 1;
      if (afterPunct >= masked.length) {
        out.push(makeSentence(text, start, masked.length));
        start = masked.length;
        break;
      }
      // Allow multiple punct (e.g. `?!`, `...`).
      let j = afterPunct;
      while (
        j < masked.length &&
        (masked[j] === "." || masked[j] === "!" || masked[j] === "?")
      ) {
        j++;
      }
      // Must be followed by whitespace…
      if (j < masked.length && /\s/.test(masked[j])) {
        // …then by a sentence-starter (capital, digit, quote, paren). Skip
        // the whitespace run.
        let k = j;
        while (k < masked.length && /\s/.test(masked[k])) k++;
        if (k >= masked.length) {
          // Trailing whitespace at end of input — close the current sentence.
          out.push(makeSentence(text, start, j));
          start = k;
          break;
        }
        const next = masked[k];
        const starter =
          (next >= "A" && next <= "Z") ||
          (next >= "0" && next <= "9") ||
          next === '"' ||
          next === "'" ||
          next === "(" ||
          next === "[" ||
          next === "`" ||
          next === "“" ||
          next === "‘";
        if (starter) {
          // Abbreviation guard: if the token ending at `j` is in the allow
          // list, don't split.
          const tokenEnd = j; // inclusive of all punct
          let tokenStart = tokenEnd - 1;
          while (tokenStart > start && !/\s/.test(masked[tokenStart - 1])) {
            tokenStart--;
          }
          const token = text.slice(tokenStart, tokenEnd);
          if (!ABBREVS.has(token)) {
            out.push(makeSentence(text, start, j));
            start = k;
            i = k;
            continue;
          }
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  if (start < text.length) {
    const tail = text.slice(start);
    if (tail.trim().length > 0) {
      out.push(makeSentence(text, start, text.length));
    }
  }
  // Always return at least one sentence when the input is non-empty.
  if (out.length === 0 && text.trim().length > 0) {
    out.push(makeSentence(text, 0, text.length));
  }
  return out;
}

function makeSentence(source: string, start: number, end: number): Sentence {
  // Trim leading whitespace inside the sentence's run so callers comparing
  // `text.slice(s.start, s.end)` get the canonical sentence body.
  let s = start;
  while (s < end && /\s/.test(source[s])) s++;
  let e = end;
  while (e > s && /\s/.test(source[e - 1])) e--;
  return { start: s, end: e, text: source.slice(s, e) };
}

/** 1-based source-line offsets (line `n` is index `n-1` of the returned
 *  array). Empty lines do not count as a line (skipped). */
export function segmentSourceLines(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      const slice = text.slice(start, i);
      if (slice.trim().length > 0) {
        out.push(makeSentence(text, start, i));
      }
      start = i + 1;
    }
  }
  return out;
}
