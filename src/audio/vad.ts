// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Voice-activity end-of-utterance detection for hands-free turn-taking (Step 3).
//
// In hands-free mode the native mic (dictation.rs) streams a growing transcript
// as `dictation-partial` events. There's no explicit "the user stopped talking"
// signal, so we infer it by timing the partial stream. As long as the transcript
// keeps growing the user is still speaking, so the end-of-utterance deadline is
// pushed out; once it stops growing for the silence window, the utterance is done
// and we hand the final text back so the caller can send the turn and keep
// listening.
//
// ENDPOINTING IS ADAPTIVE. A fixed short pause cuts people off mid-instruction:
// they breathe, gather a thought, or chain several sentences. So the pause that
// ends an utterance depends on whether the transcript so far *sounds finished*:
//   - finished (ends on sentence punctuation, or on a content word) → the base
//     `silenceMs` window.
//   - clearly mid-thought (ends on a comma/conjunction/article/preposition, i.e.
//     a word that almost never ends an instruction) → the longer `continuationMs`
//     window, so a deliberate "…and then" pause isn't mistaken for the end.
// This is a text proxy for the prosodic cues (falling pitch, trailing emphasis)
// that a true acoustic endpointer would use — those aren't available from the
// SFSpeechRecognizer partial stream, only the words are. Raising both windows
// also just makes it more patient overall.
//
// Kept as pure logic (timers injectable) so the whole VAD decision is unit-tested
// under node, unlike the native mic path which is signed-run-only.

/** A timer handle — `number` under node/jsdom, `Timeout` under the DOM. */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

/** Base end-of-utterance pause for a transcript that *sounds finished*. ~1.8s
 *  reads as "they're done", not just a mid-sentence breath, while giving enough
 *  room not to clip the end of a normal sentence. */
export const DEFAULT_VAD_SILENCE_MS = 1800;

/** Longer pause required when the transcript ends mid-thought (a trailing
 *  conjunction/article/preposition or a comma). Gives the speaker room to
 *  continue a multi-sentence instruction without being cut off. */
export const DEFAULT_VAD_CONTINUATION_MS = 3200;

/** Words that almost never end a spoken instruction — if the transcript trails
 *  off on one of these, the speaker is mid-thought and we wait the longer window.
 *  Function words (articles, conjunctions, prepositions, determiners, pronouns,
 *  auxiliaries) plus common disfluencies. */
const CONTINUATION_WORDS = new Set<string>([
  // articles / determiners
  "a", "an", "the", "this", "that", "these", "those", "my", "your", "our",
  "their", "his", "her", "its", "some", "any", "no", "every", "each",
  // conjunctions
  "and", "or", "but", "nor", "so", "yet", "because", "since", "although",
  "though", "while", "whereas", "if", "unless", "until", "as", "plus",
  // prepositions
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "onto",
  "upon", "about", "over", "under", "between", "through", "during", "after",
  "before", "without", "within", "across", "around",
  // wh- / relatives (often lead into a clause)
  "that", "which", "who", "whom", "whose", "when", "where", "why", "how",
  // pronouns / subjects that dangle
  "i", "we", "you", "they", "it", "he", "she",
  // auxiliaries / modals
  "is", "are", "was", "were", "be", "been", "will", "would", "should", "could",
  "can", "may", "might", "must", "do", "does", "did", "have", "has", "had",
  // adverbs that lead on
  "then", "also", "than", "very", "just", "really", "like", "well",
  // disfluencies / fillers
  "um", "uh", "er", "erm", "hmm", "uhh", "umm",
]);

export interface UtteranceDetectorOpts {
  /** Silence after a finished-sounding transcript that ends an utterance. */
  silenceMs?: number;
  /** Longer silence required when the transcript ends mid-thought. */
  continuationMs?: number;
  /** Called once when a pause marks the end of an utterance, with its text. */
  onUtteranceEnd: (text: string) => void;
  /** Injectable for tests; defaults to the global timer functions. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
}

/**
 * The end-of-utterance pause for a transcript: the longer `continuationMs` when
 * it ends mid-thought (sentence-internal punctuation, or a trailing function
 * word / filler), otherwise the base `silenceMs`. Exported for testing.
 */
export function endpointSilenceMs(
  text: string,
  silenceMs: number,
  continuationMs: number,
): number {
  // Drop trailing closing quotes/brackets so the real last character shows.
  const core = (text || "").trim().replace(/["'”’)\]]+$/, "");
  if (!core) return silenceMs;
  const last = core[core.length - 1];
  // A finished sentence: trust the punctuation and end on the base window.
  if (last === "." || last === "!" || last === "?") return silenceMs;
  // Sentence-internal punctuation ⇒ clearly more is coming.
  if (last === "," || last === ";" || last === ":" || last === "—" || last === "–") {
    return continuationMs;
  }
  // Otherwise judge by the trailing word.
  const m = core.toLowerCase().match(/([a-z']+)\s*$/);
  const word = m ? m[1] : "";
  if (word && CONTINUATION_WORDS.has(word)) return continuationMs;
  return silenceMs;
}

/**
 * Detects end-of-utterance from a streaming partial transcript. Feed it each
 * partial; it fires `onUtteranceEnd(finalText)` exactly once per utterance after
 * the transcript goes quiet for the adaptive pause (base, or longer when the
 * text trails off mid-thought). After firing it resets, so the next burst of
 * speech starts a fresh utterance.
 */
export class UtteranceDetector {
  private readonly silenceMs: number;
  private readonly continuationMs: number;
  private readonly onEnd: (text: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;
  private timer: TimerHandle | null = null;
  private lastText = "";

  constructor(opts: UtteranceDetectorOpts) {
    this.silenceMs = opts.silenceMs ?? DEFAULT_VAD_SILENCE_MS;
    // Default the continuation window relative to the base if only the base was
    // overridden, so a caller that sets a custom `silenceMs` still gets a longer
    // mid-thought grace period.
    this.continuationMs =
      opts.continuationMs ??
      Math.max(this.silenceMs, DEFAULT_VAD_CONTINUATION_MS, Math.round(this.silenceMs * 1.8));
    this.onEnd = opts.onUtteranceEnd;
    this.setTimer =
      opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as TimerHandle);
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Feed a streaming partial transcript. Growth pushes the deadline out (by an
   *  amount that depends on whether the text sounds finished); a stretch with no
   *  growth ends the utterance. Empty/blank and unchanged partials don't re-arm
   *  the timer, so the silence after speech runs out. */
  feed(text: string): void {
    const trimmed = (text || "").trim();
    if (!trimmed) return; // ignore pre-speech silence / blank partials
    if (trimmed === this.lastText) return; // no new speech — let silence elapse
    this.lastText = trimmed;
    this.arm(endpointSilenceMs(trimmed, this.silenceMs, this.continuationMs));
  }

  private arm(ms: number): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      const text = this.lastText;
      this.lastText = "";
      if (text) this.onEnd(text);
    }, ms);
  }

  /** Cancel any pending end and forget the current utterance. Call when
   *  (re)arming a new listen or when stopping hands-free. */
  reset(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.lastText = "";
  }

  /** True while an utterance is in progress (speech seen, pause not yet hit). */
  get pending(): boolean {
    return this.timer !== null;
  }
}
