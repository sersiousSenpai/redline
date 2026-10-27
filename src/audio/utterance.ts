// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// What a finished capture means before it is sent. Three local judgements,
// each cheap enough to make on every release:
//
// - **Non-speech.** A tap, a cough or a silent hold must not become a turn
//   (three recorded turns were just "you"). Whisper fills silence with stock
//   phrases learnt from subtitles; Apple's live recognizer, which runs under
//   every capture, hears nothing in the same audio — so "the live recognizer
//   heard no words" stands in for "the audio was near-silent".
// - **A yes or a no** to an item the agent offered, said instead of tapped.
// - **Benign recognizer errors**, which mean only "no (more) speech" and must
//   not switch hands-free off.

/** The shortest hold that can carry a word. */
export const MIN_UTTERANCE_MS = 300;

/** Whisper's silence hallucinations, normalized. */
const SILENCE_PHRASES = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you very much",
  "thank you so much",
  "thanks for watching",
  "thank you for watching",
  "thank you so much for watching",
  "please subscribe",
  "bye",
  "bye bye",
]);

/** Lowercase words only: punctuation and runs of space folded away. */
function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Capture {
  text: string;
  /** How long the talk key was held, when a key was (hands-free has none). */
  heldMs: number | null;
  /** Whether the live recognizer produced any words during the capture. */
  heard: boolean;
}

/** Whether a capture carries no speech worth sending. */
export function isNonSpeech(c: Capture): boolean {
  if (c.heldMs !== null && c.heldMs < MIN_UTTERANCE_MS) return true;
  const trimmed = c.text.trim();
  // "[BLANK_AUDIO]", "(upbeat music)": a transcriber's note, not words.
  if (/^[[(].*[\])]$/.test(trimmed)) return true;
  const words = normalizeUtterance(trimmed);
  if (!words) return true;
  if (c.heard) return false;
  // Nothing was heard live: a stock phrase, or a word or two, is the
  // transcriber filling silence.
  return SILENCE_PHRASES.has(words) || words.split(" ").length <= 2;
}

/** Fillers a reply may open with ("okay, add it"). */
const LEADING_FILLER = /^(?:um|uh|oh|so|well|hmm|okay|ok|alright|right) /;

const YES = new RegExp(
  "^(?:" +
    [
      "(?:yes|yeah|yep|yup|sure|ok|okay|please|go ahead|do it|sounds good)(?: please)?",
      "(?:(?:yes|yeah|sure) )?(?:add|keep|accept|take) (?:it|that|this|them|those|both|them all|all of them|all)" +
        "(?: as (?:feedback|an item|items))?(?: please)?",
    ].join("|") +
    ")$",
);

const NO = new RegExp(
  "^(?:" +
    [
      "no(?: thanks| thank you)?",
      "nope",
      "nah",
      "skip(?: it| that| them| those)?",
      "don't(?: add (?:it|that|them))?",
      "leave it",
      "never ?mind",
      "dismiss(?: it| that| them)?",
    ].join("|") +
    ")$",
);

/** A spoken answer to a pending offer — only when that is ALL the utterance
 *  is. Anything longer is a turn for the agent. */
export function offerAnswer(text: string): "yes" | "no" | null {
  let t = normalizeUtterance(text);
  const bare = t.replace(LEADING_FILLER, "");
  if (bare) t = bare;
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  return null;
}

/** A `dictation-error` payload (domain and code ride along when the error
 *  came from the recognizer). */
export interface DictationError {
  error: string;
  domain?: string;
  code?: number;
}

/** "No speech detected" (1110, and its 216 sibling) and "request canceled"
 *  (301): a recognizer task ending without (more) speech. Mirrors
 *  `is_benign_recognizer_error` in dictation.rs. */
export function isBenignDictationError(e: DictationError): boolean {
  return (
    (e.domain === "kAFAssistantErrorDomain" && (e.code === 1110 || e.code === 216)) ||
    (e.domain === "kLSRErrorDomain" && e.code === 301)
  );
}
