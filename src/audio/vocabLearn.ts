// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Learning from the user's corrections. When they change a word Redline has
// just dictated — within `CORRECTION_WINDOW_MS` of it landing — the pair (what
// the recognizer wrote → what they meant, "CivCore" → "Kokoro") is learned
// without a word said: it is shown only in Settings › Vocabulary, and from the
// next dictation on the rule cleanup applies it and its spelling ranks first
// in the vocabulary (vocab.ts).
//
// Only a swap counts: one to three dictated words replaced by one to three
// others. Typing more, deleting, punctuation, a sentence's capital and a
// word's ending ("test" → "tests") are editing, not a correction — and so is
// any change to an everyday word, which a learned pair would then rewrite in
// everything said after.

export const CORRECTION_WINDOW_MS = 30_000;
/** A swap is learned once the typing around it has paused this long. */
const SETTLE_MS = 1_200;
const MAX_WORDS = 3;

export interface Correction {
  heard: string;
  meant: string;
}

/** Words a pair must never rewrite. */
const EVERYDAY = new Set(
  (
    "a an the and or but nor so if then than as at by for from in into of off on onto out over to up " +
    "with without about after before under is are was were be been being am do does did done have has had " +
    "will would can could should shall may might must not no yes it its it's this that these those there " +
    "here i me my we us our you your he him his she her they them their what which who whom whose when " +
    "where why how all any some each every both one two more most less just also very too now"
  ).split(" "),
);

interface Token {
  /** As written. */
  raw: string;
  /** Without the punctuation around it: what is compared. */
  word: string;
  at: number;
}
const bare = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const tokens = (s: string, offset = 0): Token[] =>
  [...s.matchAll(/\S+/g)].map((m) => ({ raw: m[0], word: bare(m[0]), at: offset + m.index }));

/** Whether `heard` → `meant` is a correction worth keeping. `opensSentence`:
 *  the heard words started a sentence, where a capital is grammar. */
export function isCorrection(heard: string, meant: string, opensSentence: boolean): boolean {
  if (!/\p{L}/u.test(heard) || !/\p{L}/u.test(meant) || meant.length < 2) return false;
  const a = heard.toLowerCase();
  const b = meant.toLowerCase();
  if (a === b) {
    // A name's capitals: "tauri" → "Tauri" mid-sentence, "voicepanel" →
    // "VoicePanel". Never a capital taken away, nor a sentence's first.
    const capitals = (s: string) => s.replace(/[^\p{Lu}]/gu, "").length;
    return capitals(meant) > capitals(heard) && !(opensSentence && capitals(meant) === 1 && meant[0] !== heard[0]);
  }
  const was = a.split(/\s+/).map(bare);
  const now = b.split(/\s+/).map(bare);
  if (was.some((w) => EVERYDAY.has(w)) || now.some((w) => EVERYDAY.has(w))) return false;
  // Words added to the heard ones, or some of them dropped.
  if (was.every((w) => now.includes(w)) || now.every((w) => was.includes(w))) return false;
  // The same word with another ending.
  let shared = 0;
  while (shared < Math.min(a.length, b.length) && a[shared] === b[shared]) shared += 1;
  if (shared >= Math.min(a.length, b.length) - 1 && shared >= 3 && Math.abs(a.length - b.length) <= 3) return false;
  return true;
}

/** The swaps in `after` of words that `before` had between `span`'s ends. */
export function corrections(before: string, after: string, span: [number, number]): Correction[] {
  // The changed stretch, widened to whole words.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  while (head > 0 && !/\s/.test(before[head - 1])) head -= 1;
  while (tail > 0 && !/\s/.test(before[before.length - tail])) tail -= 1;
  const oldEnd = before.length - tail;
  if (oldEnd <= span[0] || head >= span[1]) return [];
  const was = tokens(before.slice(head, oldEnd), head);
  const now = tokens(after.slice(head, after.length - tail));
  // Longest common subsequence, then its gaps: each gap is a hunk.
  const n = was.length;
  const m = now.length;
  if (n * m > 40_000) return [];
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = was[i].word === now[j].word ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Correction[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && was[i].word === now[j].word) {
      i += 1;
      j += 1;
      continue;
    }
    const i0 = i;
    const j0 = j;
    while (i < n || j < m) {
      if (i < n && j < m && was[i].word === now[j].word) break;
      if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) i += 1;
      else j += 1;
    }
    const dropped = was.slice(i0, i);
    const added = now.slice(j0, j);
    if (!dropped.length || !added.length || dropped.length > MAX_WORDS || added.length > MAX_WORDS) continue;
    const from = dropped[0].at;
    const to = dropped[dropped.length - 1].at + dropped[dropped.length - 1].raw.length;
    if (from < span[0] || to > span[1]) continue;
    const heard = bare(dropped.map((t) => t.raw).join(" "));
    const meant = bare(added.map((t) => t.raw).join(" "));
    const opensSentence = !before.slice(0, from).trim() || /[.!?\n]\s*$/.test(before.slice(0, from));
    if (isCorrection(heard, meant, opensSentence)) out.push({ heard, meant });
  }
  return out;
}

/** All of a field's (or a document's) text, and where a dictation's words
 *  are in it (dictationTarget.ts's `Placed.around`). */
export interface AroundText {
  value(): string;
  /** The words' start and end in `value()`, as they were written. */
  span(): [number, number];
  /** Calls `fn` after every change the user makes; returns the way to stop. */
  onEdit(fn: () => void): () => void;
}

export interface CorrectionWatch {
  /** The dictation's words were swapped by a polish: compare from here. */
  rebase(): void;
  stop(): void;
}

/** Watch the text around a dictation for `CORRECTION_WINDOW_MS`, and learn
 *  each correction once the user's typing around it has settled — or the
 *  moment it is gone (the composer sent and cleared). */
export function watchCorrections(around: AroundText, learn: (c: Correction) => void): CorrectionWatch {
  let base = around.value();
  let span = around.span();
  let pending: Correction[] = [];
  const learned = new Set<string>();
  let settle: ReturnType<typeof setTimeout> | undefined;
  const commit = () => {
    clearTimeout(settle);
    for (const c of pending) {
      const key = `${c.heard}\u0000${c.meant}`;
      if (!learned.has(key)) {
        learned.add(key);
        learn(c);
      }
    }
    pending = [];
  };
  const look = () => {
    const found = corrections(base, around.value(), span);
    if (!found.length) return commit();
    pending = found;
    clearTimeout(settle);
    settle = setTimeout(commit, SETTLE_MS);
  };
  const unlisten = around.onEdit(look);
  const stop = () => {
    clearTimeout(deadline);
    unlisten();
    commit();
  };
  const deadline = setTimeout(stop, CORRECTION_WINDOW_MS);
  return {
    rebase() {
      base = around.value();
      span = around.span();
    },
    stop,
  };
}
