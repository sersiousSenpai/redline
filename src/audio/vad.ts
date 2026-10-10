// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The two cheap judgements end-of-turn detection (endpoint.ts) is built on:
// whether the mic is hearing a voice right now, and whether what was said so
// far sounds finished.
//
// - **Voice, from the mic's level.** The native capture reports one
//   `dictation-level` per 50 ms of audio (RMS and peak, dBFS). A window is
//   voice when it stands clear of the room: a noise floor that drops at once
//   to a quieter window and creeps up only slowly, so a fan or a hum becomes
//   the floor in a few seconds while a sentence never does. One loud window
//   on its own (a key tap, a click) is not a voice; two in a row are. This is
//   real silence, where the old detector timed the transcript — and Apple's
//   live transcript lags the audio by a beat, so a pause looked longer than
//   it was and a slow word looked like a pause.
// - **Unfinished, from the words.** A transcript that trails off on a word
//   that almost never ends a sentence ("and", "the", "um", "of") or on a
//   comma is mid-thought, and the pause after it gets longer to run. A
//   recognizer that punctuates puts a full stop at a pause, so a stop after
//   such a word does not make it finished; a question mark does.

/** Audio per `dictation-level` event (`LEVEL_WINDOW_MS` in dictation.rs). */
export const LEVEL_MS = 50;

/** How far over the room's floor a window must be to count as a voice. */
const VOICE_OVER_FLOOR_DB = 9;
/** …and never quieter than this: the level of soft speech at arm's length,
 *  and the MIC gate's speech window (RMS 0.003). */
const VOICE_MIN_DB = -50;
/** Where the floor starts, and the range it moves in. */
const FLOOR_START_DB = -60;
const FLOOR_MIN_DB = -80;
const FLOOR_MAX_DB = -38;
/** Per window: the share of the gap the floor closes towards a quieter
 *  window, and how far it may rise towards a louder one (1 dB a second). */
const FLOOR_FALL = 0.3;
const FLOOR_RISE_DB = 0.05;
/** Loud windows in a row before they are a voice. */
const MIN_RUN = 2;

export interface Level {
  /** dBFS, −100 for digital silence. */
  rms: number;
  peak: number;
}

/** Per-window voice detection against the room's own floor. */
export class VoiceActivity {
  private floor = FLOOR_START_DB;
  private loud = 0;

  /** Whether this window is a voice (and so is every window of the run once
   *  it is long enough — the run's first window is counted late). */
  push(level: Level): boolean {
    const loud = level.rms >= Math.max(this.floor + VOICE_OVER_FLOOR_DB, VOICE_MIN_DB);
    this.loud = loud ? this.loud + 1 : 0;
    if (level.rms < this.floor) {
      this.floor += (level.rms - this.floor) * FLOOR_FALL;
    } else {
      this.floor += Math.min(level.rms - this.floor, FLOOR_RISE_DB);
    }
    this.floor = Math.min(FLOOR_MAX_DB, Math.max(FLOOR_MIN_DB, this.floor));
    return this.loud >= MIN_RUN;
  }

  /** Loud windows in a row so far: how long the current sound has lasted. */
  get run(): number {
    return this.loud;
  }

  /** The room's level as heard so far, dBFS. */
  get noiseFloor(): number {
    return this.floor;
  }
}

/** Words that leave a sentence hanging: articles and possessives (a noun is
 *  coming), conjunctions, prepositions that need an object, fillers, a
 *  dangling subject, a copula. Words that often do end a request stay out:
 *  "it", "that", "this", "in", "on", "up", "so", "then", "do", "can". */
const DANGLING = new Set([
  "a", "an", "the", "my", "your", "our", "their", "its", "every",
  "and", "or", "but", "nor", "plus", "because", "although", "whereas",
  "unless", "until", "whether", "than", "if",
  "of", "to", "with", "from", "into", "onto", "upon", "for", "at", "by",
  "about", "via", "toward", "towards", "like",
  "um", "uh", "uhm", "umm", "uhh", "er", "erm", "hmm", "mm",
  "i", "we", "they",
  "is", "are", "was", "were",
]);

/** "and then", "or maybe": a conjunction and the adverb that carries on. */
const CARRY_ON = new Set(["then", "so", "also", "maybe", "still"]);
const CONJUNCTION = new Set(["and", "or", "but"]);

/** Whether `text` sounds like the speaker is mid-thought. */
export function looksUnfinished(text: string): boolean {
  // Closing quotes and brackets hide the real last character.
  const core = text.trim().replace(/["'”’)\]]+$/, "").trimEnd();
  if (!core) return false;
  // A trailing ellipsis, or sentence-internal punctuation: more is coming.
  if (/(\.\.\.|…|[,;:—–-])$/.test(core)) return true;
  if (/[?!]$/.test(core)) return false;
  // Otherwise the last words decide, with or without a full stop after them.
  const words = core.toLowerCase().replace(/’/g, "'").match(/[a-z']+/g);
  if (!words) return false;
  const last = words[words.length - 1];
  if (DANGLING.has(last)) return true;
  const before = words[words.length - 2];
  return CARRY_ON.has(last) && before !== undefined && CONJUNCTION.has(before);
}
