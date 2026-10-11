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
//   2. names the open plan capitalizes for their own sake ("Kokoro",
//      "Front Door");
//   3. the code names it mentions that the project's own files are named
//      after (VoicePanel) — a name both said in the plan and real in the code;
//   4. the project's code names it doesn't mention, those of the files
//      changed most lately first (`projectVocab`), up to `PROJECT_RANKED`;
//   5. the rest of the plan's code names (dictation_start, an API's names);
//   6. its acronyms, which recognizers mostly spell out right unaided;
//   7. file names, the plan's and then the rest of the project's — rarely
//      said aloud as written;
//   8. names from the memory index (the class titles of what the user has
//      planned and decided), which a long plan crowds out first.
// Within each source, the most frequent first. Whisper's prompt takes only
// the first `PROMPT_TERMS` (dictation_whisper.rs): more terms than that
// measured worse.
//
// The user's words are stored in the settings database as the `voiceVocab`
// ui pref, so they survive a cache clear and travel with the database. Every
// change goes through `updateVocabStore`, which tells the dictation host and
// an open Settings › Vocabulary at once.

import { invoke } from "@tauri-apps/api/core";

/** At most this many terms reach the recognizers per capture (dictation.rs
 *  caps at the same number). */
export const VOCAB_CAP = 150;
/** How many of the project's own names rank above the rest of the plan's. */
export const PROJECT_RANKED = 24;

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
  /** The session's project's code names, the most lately changed first
   *  (`projectVocab`). */
  identifiers?: string[];
  /** Names from the memory index (`memoryVocab`). */
  memory?: string[];
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
/** Code names: a word with a lowercase letter and an inner capital
 *  (VoicePanel, useStickToBottom, SQLite, macOS), or snake_case
 *  (dictation_start). */
const CODE =
  /\b(?=[A-Za-z0-9]*[a-z])[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
/** A whole word that is a code name, as `CODE` finds them in text. */
const CODE_NAME =
  /^(?:(?=[A-Za-z0-9]*[a-z])[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/;
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

/** The vocabulary a plan's text carries, each kind most frequent first. */
export interface PlanVocab {
  /** Names it capitalizes for their own sake ("Kokoro", "Front Door"). */
  names: string[];
  /** CamelCase and snake_case names (VoicePanel, dictation_start). */
  code: string[];
  /** Acronyms (MLX, PCM). */
  acronyms: string[];
  /** File names, without their folders (tts.rs, VoicePanel.tsx). */
  files: string[];
}

/** Read a plan's vocabulary. Fenced code is skipped — its names are usually
 *  not what anyone says aloud — but inline code spans count. */
export function planVocab(markdown: string): PlanVocab {
  const text = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, " ");
  const files = new Map<string, { term: string; n: number }>();
  tally(text, FILE_NAME, files, (m) => m[1].split("/").pop() ?? m[1]);
  const code = new Map<string, { term: string; n: number }>();
  tally(text, CODE, code);
  const acronyms = new Map<string, { term: string; n: number }>();
  tally(text, ACRONYM, acronyms);
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
    if (code.has(key) || files.has(key)) continue;
    if (mid) midSentence.add(key);
    const seen = named.get(key);
    if (seen) seen.n += 1;
    else named.set(key, { term: run, n: 1 });
  }
  // A name is capitalized somewhere a sentence doesn't start: "the Front
  // Door", "local Whisper" — not a heading's "Door Rules" or an opening
  // "Describe".
  for (const key of named.keys()) if (!midSentence.has(key)) named.delete(key);
  // "SIZE", "USER": a heading's capitals, not an acronym.
  for (const key of acronyms.keys()) if (ordinary(key)) acronyms.delete(key);
  // `browserChat` where the prose also says "browser chat": the words are how
  // people talk, and a recognizer (or the rules) told the name would join
  // them into it.
  const spoken = prose.toLowerCase();
  for (const [key, { term }] of code) {
    const words = term.split(/(?=[A-Z])/).map((w) => w.toLowerCase());
    if (/^[a-z]/.test(term) && words.length > 1 && new RegExp(`\\b${words.join("\\s+")}\\b`).test(spoken)) code.delete(key);
  }
  return { names: ranked(named), code: ranked(code), acronyms: ranked(acronyms), files: ranked(files) };
}

/** The project's code names among its file names (`dictation_identifiers`,
 *  the most lately changed first): VoicePanel.tsx is VoicePanel,
 *  dictation_whisper.rs is dictation_whisper, and README.md is no name. */
export function projectVocab(files: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const stem = file.split(".")[0];
    if (!CODE_NAME.test(stem) || stem.length > TERM_MAX || seen.has(stem.toLowerCase())) continue;
    seen.add(stem.toLowerCase());
    out.push(stem);
  }
  return out;
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
  const plan = planVocab(sources.plan ?? "");
  const project = sources.identifiers ?? [];
  const real = new Set(project.map((t) => t.toLowerCase()));
  for (const t of plan.names) add(t);
  for (const t of plan.code) if (real.has(t.toLowerCase())) add(t);
  for (const t of project.slice(0, PROJECT_RANKED)) add(t);
  for (const t of [...plan.code, ...plan.acronyms, ...plan.files, ...project]) add(t);
  for (const t of sources.memory ?? []) add(t);
  return out;
}

/** The names in the memory index's class titles. Each title is read as a
 *  sentence of its own, so a capital counts only where it is not the
 *  sentence's — except a title opening on two or more capitalized words,
 *  which is a name ("Front Door return"): a lone first word ("Voice agent")
 *  may be one or not, and a wrong one would recase that word everywhere. */
export function memoryVocab(titles: string[]): string[] {
  const v = planVocab(titles.map((t) => `${t.trim()}.`).join("\n"));
  const opening = titles
    .map((t) => /^[A-Z][a-z][a-zA-Z]*(?: [A-Z][a-z][a-zA-Z]*){1,2}\b/.exec(t.trim())?.[0])
    .filter((run): run is string => !!run && !run.split(" ").some((w) => COMMON.has(w.toLowerCase())));
  return [...v.names, ...opening, ...v.code, ...v.acronyms];
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

/** Forget the correction learned for `heard`. */
export function forgetPair(store: VocabStore, heard: string): VocabStore {
  const key = heard.trim().toLowerCase();
  return { ...store, pairs: store.pairs.filter((p) => p.heard.toLowerCase() !== key) };
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

const listeners = new Set<(store: VocabStore) => void>();

/** Hear every saved change to the user's words. */
export function onVocabStore(fn: (store: VocabStore) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Change the stored words: read fresh, so a pair learned while Settings is
 *  open and a word removed there never undo each other. */
export async function updateVocabStore(change: (store: VocabStore) => VocabStore): Promise<VocabStore> {
  const next = change(await loadVocabStore());
  await invoke("set_ui_pref", { key: "voiceVocab", value: JSON.stringify(next) });
  for (const fn of listeners) fn(next);
  return next;
}
