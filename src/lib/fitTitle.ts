// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// A title in the door's recents gets as many lines as its column allows, and
// past that it is cut at the last whole word that fits — never mid-word, as a
// line clamp would ("senso…"). Pure: the caller measures.

/** A hyphen between two letters, made non-breaking, so a balanced wrap can't
 *  split "barge-in" across lines. */
export function keepHyphens(text: string): string {
  return text.replace(/(\p{L})-(?=\p{L})/gu, "$1\u2011");
}

/** `full` if it fits, else the most leading whole words that fit with "…",
 *  trailing punctuation dropped first. A single word too long for the column
 *  is kept whole: the stylesheet clips it. */
export function fitTitle(full: string, fits: (text: string) => boolean): string {
  const words = full.split(/\s+/).filter(Boolean);
  if (words.length < 2 || fits(full)) return full;
  const cut = (count: number) => `${words.slice(0, count).join(" ").replace(/[\s,;:·—–-]+$/u, "")}…`;
  // The most words that still fit, by halves: a title is a few dozen words at
  // most, and each try is a layout read.
  let low = 1, high = words.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (fits(cut(middle))) low = middle;
    else high = middle - 1;
  }
  return cut(low);
}
