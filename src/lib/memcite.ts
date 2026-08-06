// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Citation extraction for the Memory surface's Ask replies (Second Brain P4).
// The Ask agent is taught to cite its evidence inline — a ledger event as
// `#<seq>` and a catalog class as `[[Title]]` — and the Ask tab turns what it
// actually wrote into chips that drive the Timeline. Pure and dependency-free
// so the contract is unit-testable without a DOM (the `timeline.ts`
// discipline): the body renders through the markdown pipeline untouched; only
// the chip row is derived here.

/** What one reply cites: ledger seqs and catalog class titles, each deduped
 *  in first-mention order. */
export interface Citations {
  seqs: number[];
  classes: string[];
}

/** Chip-row caps — a reply that cites half the ledger gets its head, not a
 *  wall of chips. */
export const MAX_SEQ_CHIPS = 12;
export const MAX_CLASS_CHIPS = 6;

/** Fenced blocks and inline code spans are quoted material, not citations —
 *  a seq inside a curl example must not become a chip. */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * Extract the citations from one Ask reply. A seq citation is `#123` preceded
 * by start-of-line, whitespace, or common punctuation (so `x#1` in an
 * identifier and `##` headings never match); a class citation is
 * `[[Title]]` on one line. Order is first mention; duplicates collapse
 * case-insensitively for classes.
 */
export function extractCitations(body: string): Citations {
  const text = stripCode(body);
  const seqs: number[] = [];
  const seenSeq = new Set<number>();
  for (const m of text.matchAll(/(^|[\s([{,;:—–-])#(\d{1,10})(?!\d)/gm)) {
    const n = Number(m[2]);
    if (!seenSeq.has(n)) {
      seenSeq.add(n);
      seqs.push(n);
      if (seqs.length >= MAX_SEQ_CHIPS) break;
    }
  }
  const classes: string[] = [];
  const seenClass = new Set<string>();
  for (const m of text.matchAll(/\[\[([^[\]\n]{1,80})\]\]/g)) {
    const title = m[1].trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (!seenClass.has(key)) {
      seenClass.add(key);
      classes.push(title);
      if (classes.length >= MAX_CLASS_CHIPS) break;
    }
  }
  return { seqs, classes };
}
