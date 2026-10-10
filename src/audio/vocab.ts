// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The dictation vocabulary: the words a capture biases the recognizers toward,
// so "Kokoro" comes out as Kokoro and not as whatever English word sounds
// closest. Built here rather than in Rust, which only receives the finished,
// ranked list with each capture (`dictation_start`'s `vocab`): Apple's
// recognizer gets it as contextual strings, Whisper as its prompt — the most
// important terms nearest the audio, and only once the audio has passed the
// silence gate.
//
// Ranked sources, best first, `VOCAB_CAP` terms in all:
//   1. the user's own words: the dictionary, and the right half of each
//      correction learned from them. They are few and explicit, and a learned
//      correction is proof the recognizer already got that word wrong once,
//      so a long plan never crowds them out;
//   2. terms from the open plan: proper names ("Kokoro", "Front Door") and
//      acronyms, most frequent first;
//   3. identifiers from the session's project: file names and CamelCase or
//      snake_case names in the plan, then any the caller adds.
//
// The user's words are stored in the settings database as the `voiceVocab`
// ui pref, so they survive a cache clear and travel with the database.

import { invoke } from "@tauri-apps/api/core";

/** At most this many terms reach the recognizers per capture (dictation.rs
 *  caps at the same number). */
export const VOCAB_CAP = 150;

/** A correction the user made to a dictated word: what the recognizer wrote,
 *  and what they meant. */
export interface LearnedPair {
  heard: string;
  meant: string;
  /** When it was learned (ms since the epoch). */
  at: number;
}

export interface VocabStore {
  words: string[];
  pairs: LearnedPair[];
}

export interface VocabSources {
  /** The open plan's (or draft's) markdown. */
  plan?: string;
  /** More identifiers from the session's project, such as file names. */
  identifiers?: string[];
  /** The user's stored words and learned corrections. */
  store?: VocabStore;
}

/** The longest term worth sending (dictation.rs drops longer ones too). */
const TERM_MAX = 64;
/** How many of each the store keeps; the oldest go first. */
const WORDS_KEPT = 200;
const PAIRS_KEPT = 100;

/** File names worth hearing: source, docs and config. */
const FILE_NAME =
  /(?:^|[\s`'"(/])([\w.-]*\w\.(?:rs|tsx?|jsx?|mjs|cjs|json|md|py|swift|toml|ya?ml|css|html|sh|sql))(?=$|[\s`'",;:)!?]|\.(?:\s|$))/gm;
/** A word with a lowercase letter and an inner capital (VoicePanel,
 *  useStickToBottom, SQLite, macOS). */
const CAMEL = /\b(?=[A-Za-z0-9]*[a-z])[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g;
/** snake_case names (dictation_start). */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
/** Two to six capitals, maybe with a trailing digit (MLX, PCM, JSON, TTS). */
const ACRONYM = /\b[A-Z]{2,6}[0-9]?\b/g;
/** A run of capitalized words (Front Door, Neural Engine, Kokoro). */
const CAPITALIZED = /\b[A-Z][a-z][a-zA-Z]*(?:[ -][A-Z][a-z][a-zA-Z]*){0,2}\b/g;

/** Capitalized only because they open a sentence or a heading, or are
 *  everyday words a plan capitalizes; never vocabulary on their own. */
const COMMON = new Set(
  (
    "a an and are as at be but by can do does for from has have how i if in into is it its " +
    "keep let make may must new no not of on once one only or our out run see should so " +
    "some that the then there these this those to two use was we what when where which while " +
    "who why will with yes you your add also all any after before both each every first get " +
    "give here just last like more most next now off open over same set show still such take " +
    "tell than them they too under until up very via way well when within without would " +
    "note todo done step phase item items lane wave test tests file files plan plans fix fixes " +
    "goal goals summary overview context details detail status result results example examples " +
    "question questions decision decisions rule rules option options section part parts " +
    "kb mb gb ms"
  ).split(" "),
);

/** Count each match of `re` in `text` into `counts` (first spelling wins). */
function tally(text: string, re: RegExp, counts: Map<string, { term: string; n: number }>, pick = (m: RegExpExecArray) => m[0]) {
  for (const m of text.matchAll(re)) {
    const term = pick(m).trim();
    if (!term || term.length > TERM_MAX) continue;
    const key = term.toLowerCase();
    const seen = counts.get(key);
    if (seen) seen.n += 1;
    else counts.set(key, { term, n: 1 });
  }
}

/** Most frequent first; a tie keeps the order of first appearance. */
function ranked(counts: Map<string, { term: string; n: number }>): string[] {
  return [...counts.values()]
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((c) => c.term);
}

/** The vocabulary a plan's text carries: `terms` (proper names, acronyms)
 *  and `identifiers` (file names and the code names in it), each most
 *  frequent first. Fenced code is skipped — its names are usually not what
 *  anyone says aloud — but inline code spans count. */
export function planVocab(markdown: string): { terms: string[]; identifiers: string[] } {
  const text = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, " ");
  const ids = new Map<string, { term: string; n: number }>();
  tally(text, FILE_NAME, ids, (m) => m[1].split("/").pop() ?? m[1]);
  tally(text, CAMEL, ids);
  tally(text, SNAKE, ids);

  const terms = new Map<string, { term: string; n: number }>();
  tally(text, ACRONYM, terms);
  // Prose only: a capitalized run inside a code span is an identifier's piece.
  const prose = text.replace(/`[^`\n]*`/g, " ");
  // Words the text also writes in lowercase are ordinary words, capitalized
  // only where a sentence or heading starts with them.
  const lower = new Set(prose.match(/\b[a-z][a-z']*\b/g) ?? []);
  const named = new Map<string, { term: string; n: number }>();
  const midSentence = new Set<string>();
  const ordinary = (w: string) => COMMON.has(w.toLowerCase()) || lower.has(w.toLowerCase());
  for (const m of prose.matchAll(CAPITALIZED)) {
    let words = m[0].split(/[ -]/);
    let mid = /[a-z0-9,;)]\s$/.test(prose.slice(Math.max(0, m.index - 3), m.index));
    // "The Front Door", "Keep Kokoro": an everyday word in front is the
    // sentence's start, and what follows it is capitalized for its own sake.
    // (Only everyday words: "Front" stays, though the plan says "front" too.)
    while (words.length > 1 && COMMON.has(words[0].toLowerCase())) {
      words = words.slice(1);
      mid = true;
    }
    const run = words.join(" ");
    const key = run.toLowerCase();
    if (words.some((w) => COMMON.has(w.toLowerCase()))) continue;
    if (words.length === 1 && lower.has(key)) continue;
    if (ids.has(key)) continue;
    if (mid) midSentence.add(key);
    const seen = named.get(key);
    if (seen) seen.n += 1;
    else named.set(key, { term: run, n: 1 });
  }
  // A name is capitalized somewhere a sentence doesn't start: "the Front
  // Door", "local Whisper" — not a heading's "Door Rules" or an opening
  // "Describe".
  for (const [key, c] of named) {
    if (!midSentence.has(key)) continue;
    const seen = terms.get(key);
    if (seen) seen.n += c.n;
    else terms.set(key, c);
  }
  // "SIZE", "USER": a heading's capitals, not an acronym.
  for (const key of terms.keys()) if (ordinary(key)) terms.delete(key);
  return { terms: ranked(terms), identifiers: ranked(ids) };
}

/** The ranked vocabulary for one capture (see the ranking at the top). */
export function buildVocab(sources: VocabSources, cap = VOCAB_CAP): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (term: string) => {
    const t = term.trim();
    const key = t.toLowerCase();
    if (!t || t.length > TERM_MAX || seen.has(key) || out.length >= cap) return;
    seen.add(key);
    out.push(t);
  };
  const store = sources.store;
  // Newest corrections first: the freshest evidence of a mishearing.
  for (const p of [...(store?.pairs ?? [])].sort((a, b) => b.at - a.at)) add(p.meant);
  for (const w of store?.words ?? []) add(w);
  const fromPlan = planVocab(sources.plan ?? "");
  for (const t of fromPlan.terms) add(t);
  for (const t of fromPlan.identifiers) add(t);
  for (const t of sources.identifiers ?? []) add(t);
  return out;
}

/** The stored words, tolerating a missing or damaged blob. */
export function parseVocabStore(raw: string | null | undefined): VocabStore {
  try {
    const v = JSON.parse(raw ?? "") as Partial<VocabStore>;
    const words = Array.isArray(v.words) ? v.words.filter((w): w is string => typeof w === "string") : [];
    const pairs = Array.isArray(v.pairs)
      ? v.pairs.filter(
          (p): p is LearnedPair =>
            !!p && typeof p.heard === "string" && typeof p.meant === "string" && typeof p.at === "number",
        )
      : [];
    return { words, pairs };
  } catch {
    return { words: [], pairs: [] };
  }
}

/** Add a word the user typed in (a repeat moves to the front). */
export function addWord(store: VocabStore, word: string): VocabStore {
  const w = word.trim();
  if (!w || w.length > TERM_MAX) return store;
  const rest = store.words.filter((x) => x.toLowerCase() !== w.toLowerCase());
  return { ...store, words: [w, ...rest].slice(0, WORDS_KEPT) };
}

export function removeWord(store: VocabStore, word: string): VocabStore {
  const key = word.trim().toLowerCase();
  return {
    words: store.words.filter((x) => x.toLowerCase() !== key),
    pairs: store.pairs.filter((p) => p.meant.toLowerCase() !== key),
  };
}

/** Learn that `heard` meant `meant`. A newer correction of the same heard
 *  text replaces the older one. */
export function learnPair(store: VocabStore, heard: string, meant: string, at: number): VocabStore {
  const h = heard.trim();
  const m = meant.trim();
  if (!h || !m || h === m || m.length > TERM_MAX) return store;
  const rest = store.pairs.filter((p) => p.heard.toLowerCase() !== h.toLowerCase());
  return { ...store, pairs: [{ heard: h, meant: m, at }, ...rest].slice(0, PAIRS_KEPT) };
}

export async function loadVocabStore(): Promise<VocabStore> {
  try {
    const prefs = await invoke<{ voiceVocab?: string | null }>("get_ui_prefs");
    return parseVocabStore(prefs.voiceVocab);
  } catch {
    return { words: [], pairs: [] };
  }
}

export async function saveVocabStore(store: VocabStore): Promise<void> {
  await invoke("set_ui_pref", { key: "voiceVocab", value: JSON.stringify(store) });
}
