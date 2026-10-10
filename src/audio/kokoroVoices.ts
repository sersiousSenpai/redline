// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Kokoro-82M's English voices, with the grade its author publishes for each
// (hexgrad/Kokoro-82M, VOICES.md, "Overall Grade"). A grade estimates the
// quality and quantity of a voice's training audio, which is most of what
// separates a natural voice from a rough one, so the picker leads with it.
// Voices for other languages are left out: the sidecar phonemizes English.

/** Grades, best first, as VOICES.md writes them. */
const GRADES = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F+", "F", "F-"];

/** Every English voice in VOICES.md's order (US, then UK; women, then men).
 *  The id carries the rest: `a`/`b` is US/UK, `f`/`m` is female/male. */
const GRADED: [string, string][] = [
  ["af_heart", "A"],
  ["af_alloy", "C"],
  ["af_aoede", "C+"],
  ["af_bella", "A-"],
  ["af_jessica", "D"],
  ["af_kore", "C+"],
  ["af_nicole", "B-"],
  ["af_nova", "C"],
  ["af_river", "D"],
  ["af_sarah", "C+"],
  ["af_sky", "C-"],
  ["am_adam", "F+"],
  ["am_echo", "D"],
  ["am_eric", "D"],
  ["am_fenrir", "C+"],
  ["am_liam", "D"],
  ["am_michael", "C+"],
  ["am_onyx", "D"],
  ["am_puck", "C+"],
  ["am_santa", "D-"],
  ["bf_alice", "D"],
  ["bf_emma", "B-"],
  ["bf_isabella", "C"],
  ["bf_lily", "D"],
  ["bm_daniel", "D"],
  ["bm_fable", "C"],
  ["bm_george", "C"],
  ["bm_lewis", "D+"],
];

export interface KokoroVoice {
  id: string;
  /** "Heart" */
  name: string;
  /** "US female"; empty for an id that isn't one of Kokoro's English voices. */
  kind: string;
  /** "A-"; empty when Kokoro publishes no grade for it. */
  grade: string;
}

const gradeOf = new Map(GRADED);

/** Where a grade sorts: 0 is best; ungraded sorts last. */
export function gradeRank(grade: string): number {
  const i = GRADES.indexOf(grade);
  return i < 0 ? GRADES.length : i;
}

/** A grade below C- marks a voice with thin or poor training audio. */
export const isLowGrade = (grade: string) => gradeRank(grade) > gradeRank("C-");

export function describeVoice(id: string): KokoroVoice {
  const grade = gradeOf.get(id) ?? "";
  const word = id.slice(id.indexOf("_") + 1);
  const name = word.charAt(0).toUpperCase() + word.slice(1);
  const accent = { a: "US", b: "UK" }[id[0]];
  const voice = { f: "female", m: "male" }[id[1]];
  return { id, name, kind: grade && accent && voice ? `${accent} ${voice}` : "", grade };
}

/** The picker's list: best grade first, VOICES.md's order within a grade. */
export const KOKORO_VOICES: KokoroVoice[] = GRADED.map(([id]) => describeVoice(id)).sort(
  (a, b) => gradeRank(a.grade) - gradeRank(b.grade),
);

/** A stored voice is one id, or two joined by "+": an even blend of both,
 *  which the sidecar makes by averaging their style vectors. */
export function splitBlend(value: string): [string, string | null] {
  const [first, second] = value.split("+");
  return [first, second || null];
}

export function joinBlend(voice: string, blend: string | null): string {
  return blend && blend !== voice ? `${voice}+${blend}` : voice;
}
