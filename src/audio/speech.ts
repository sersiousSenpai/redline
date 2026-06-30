// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Text-to-speech for the voice agent. The brain (a warm `claude` session, or
// the mechanical Verbatim reader) produces text incrementally; `SpeechQueue`
// turns that stream into spoken audio sentence-by-sentence, so the first
// sentence is heard while the rest is still being generated. All speech goes
// through the WebView's built-in `speechSynthesis` — zero dependencies, local,
// and the same system voices the OS exposes.
//
// The synth is injected (`SpeechDriver`) so the buffering / sentence-splitting
// logic is unit-testable under node, where `window.speechSynthesis` is absent.

/** Spoken state, surfaced to the UI ("speaking" lights the indicator). */
export type SpeechState = "idle" | "speaking" | "paused";

/** Persisted voice preferences (mirrors how theme/font persist). */
export interface VoicePrefs {
  /** `SpeechSynthesisVoice.voiceURI`, or null for the engine default. */
  voiceURI: string | null;
  /** Playback rate, 0.5–2.0 (1 = normal). */
  rate: number;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = { voiceURI: null, rate: 1 };

const PREFS_KEY = "redline.voice.prefs";

export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_VOICE_PREFS };
    const p = JSON.parse(raw) as Partial<VoicePrefs>;
    return {
      voiceURI: typeof p.voiceURI === "string" ? p.voiceURI : null,
      rate: clampRate(typeof p.rate === "number" ? p.rate : 1),
    };
  } catch {
    return { ...DEFAULT_VOICE_PREFS };
  }
}

export function saveVoicePrefs(prefs: VoicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — preferences are best-effort */
  }
}

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(rate * 100) / 100));
}

/** Whether to run raw dictation through the AI cleanup pass before sending.
 * Defaults to on (the whole point is Wispr-style polish); persisted separately
 * so toggling it never disturbs the speech prefs blob. */
const CLEANUP_KEY = "redline.voice.cleanup";

export function loadCleanupEnabled(): boolean {
  try {
    // Absent key → default on.
    return localStorage.getItem(CLEANUP_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveCleanupEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(CLEANUP_KEY, enabled ? "1" : "0");
  } catch {
    /* private mode / quota — best-effort */
  }
}

/**
 * Pull every *complete* sentence off the front of a streaming buffer, leaving
 * the trailing partial sentence behind for the next chunk. Boundaries are
 * sentence-final punctuation (`.`/`!`/`?`, plus any closing quote/bracket)
 * followed by whitespace or end-of-input, and hard newlines (so a heading or
 * list item is spoken as its own unit rather than waiting for a period that
 * never comes).
 */
export function takeSentences(buffer: string): {
  sentences: string[];
  rest: string;
} {
  const sentences: string[] = [];
  let start = 0;
  let i = 0;
  const flush = (end: number) => {
    const s = buffer.slice(start, end).trim();
    if (s) sentences.push(s);
    start = end;
  };
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === "\n") {
      flush(i + 1);
      i += 1;
      continue;
    }
    if (ch === "." || ch === "!" || ch === "?") {
      // Absorb trailing closing punctuation: e.g. `word.")` .
      let j = i + 1;
      while (j < buffer.length && /["'”’)\]]/.test(buffer[j])) j += 1;
      const next = buffer[j];
      if (next === undefined) break; // sentence may continue in the next chunk
      if (/\s/.test(next)) {
        flush(j);
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return { sentences, rest: buffer.slice(start) };
}

/**
 * Pull the first speakable chunk for a *low-latency turn start*: a full sentence
 * if one is already complete, otherwise the first clause (after a comma / dash /
 * colon / semicolon) once there's enough to sound natural, otherwise a hard cut
 * once it runs long with no break. Returns `null` if it's still too early to say
 * anything. This lets the very first audio of a reply start as soon as a phrase
 * is available instead of waiting for the first sentence-final period.
 */
export function takeFirstChunk(
  buffer: string,
): { chunk: string; rest: string } | null {
  const MIN = 24; // don't speak a tiny opening fragment
  const HARD = 110; // ...but start anyway if it runs on with no break
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === "\n" || ch === "." || ch === "!" || ch === "?") {
      let j = i + 1;
      while (j < buffer.length && /["'”’)\]]/.test(buffer[j])) j += 1;
      const next = buffer[j];
      if (ch === "\n" || next === undefined || /\s/.test(next)) {
        const end = ch === "\n" ? i + 1 : j;
        const chunk = buffer.slice(0, end).trim();
        if (chunk) return { chunk, rest: buffer.slice(end) };
      }
    } else if (
      (ch === "," || ch === ";" || ch === ":" || ch === "—" || ch === "–") &&
      i + 1 >= MIN
    ) {
      const next = buffer[i + 1];
      if (next === undefined || /\s/.test(next)) {
        const chunk = buffer.slice(0, i + 1).trim();
        if (chunk) return { chunk, rest: buffer.slice(i + 1) };
      }
    }
  }
  if (buffer.length >= HARD) {
    const cut = buffer.lastIndexOf(" ", HARD);
    const at = cut > MIN ? cut : HARD;
    return { chunk: buffer.slice(0, at).trim(), rest: buffer.slice(at) };
  }
  return null;
}

/**
 * The minimal slice of `window.speechSynthesis` that `SpeechQueue` needs.
 * `speak(text, …, onDone)` must invoke `onDone` when the utterance finishes
 * (or errors), so the queue can track outstanding speech for the state flag.
 */
export interface SpeechDriver {
  speak(
    text: string,
    opts: { rate: number; voiceURI: string | null },
    onDone: () => void,
  ): void;
  cancel(): void;
  pause(): void;
  resume(): void;
}

/**
 * Buffers a text stream and speaks it as complete sentences arrive. The real
 * `speechSynthesis` queues utterances internally, so forwarding each sentence
 * immediately preserves order; `cancel()` (barge-in / Stop) clears everything.
 */
export class SpeechQueue {
  private driver: SpeechDriver;
  private buffer = "";
  private outstanding = 0;
  private state: SpeechState = "idle";
  private onState?: (s: SpeechState) => void;
  // When true, the next enqueue tries to emit an early first chunk (clause-level)
  // so a reply starts speaking sooner; cleared once that first chunk is spoken.
  private firstChunkPending = false;
  prefs: VoicePrefs;

  constructor(opts?: {
    driver?: SpeechDriver;
    prefs?: VoicePrefs;
    onState?: (s: SpeechState) => void;
  }) {
    this.driver = opts?.driver ?? browserSpeechDriver();
    this.prefs = opts?.prefs ?? loadVoicePrefs();
    this.onState = opts?.onState;
  }

  getState(): SpeechState {
    return this.state;
  }

  setPrefs(prefs: VoicePrefs): void {
    this.prefs = { voiceURI: prefs.voiceURI, rate: clampRate(prefs.rate) };
  }

  /** Swap the speech engine (e.g. system ↔ cloud TTS). Cancels anything in
   *  flight so the change takes effect cleanly. */
  setDriver(driver: SpeechDriver): void {
    this.cancel();
    this.driver = driver;
  }

  /** Begin a streamed turn: the first chunk speaks at the first clause (not the
   *  first full sentence), so audio starts sooner. */
  primeTurn(): void {
    this.firstChunkPending = true;
  }

  /** Append streamed text; speak any sentences that are now complete. */
  enqueue(text: string): void {
    if (!text) return;
    this.buffer += text;
    if (this.firstChunkPending) {
      const first = takeFirstChunk(this.buffer);
      if (!first) return; // not enough yet to start the reply naturally
      this.firstChunkPending = false;
      this.buffer = first.rest;
      this.speakNow(first.chunk);
    }
    const { sentences, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    for (const s of sentences) this.speakNow(s);
  }

  /** Speak whatever partial text remains (call when the stream ends). */
  flush(): void {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail) this.speakNow(tail);
  }

  /** Stop immediately and drop any buffered/queued speech (Stop / barge-in). */
  cancel(): void {
    this.buffer = "";
    this.outstanding = 0;
    this.firstChunkPending = false;
    this.driver.cancel();
    this.setState("idle");
  }

  pause(): void {
    if (this.state !== "speaking") return;
    this.driver.pause();
    this.setState("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.driver.resume();
    this.setState("speaking");
  }

  private speakNow(sentence: string): void {
    this.outstanding += 1;
    this.setState("speaking");
    this.driver.speak(
      sentence,
      { rate: this.prefs.rate, voiceURI: this.prefs.voiceURI },
      () => {
        this.outstanding = Math.max(0, this.outstanding - 1);
        if (this.outstanding === 0 && this.state !== "paused") {
          this.setState("idle");
        }
      },
    );
  }

  private setState(s: SpeechState): void {
    if (s === this.state) return;
    this.state = s;
    this.onState?.(s);
  }
}

/** Resolve available system voices, waiting for the async `voiceschanged`
 *  population that some engines (incl. WebKit) do on first call. */
export function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  const synth =
    typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return Promise.resolve([]);
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener?.("voiceschanged", onChange);
      resolve(synth.getVoices());
    };
    const onChange = () => finish();
    synth.addEventListener?.("voiceschanged", onChange);
    setTimeout(finish, timeoutMs);
  });
}

/** Build a `SpeechDriver` over the live `window.speechSynthesis`. */
export function browserSpeechDriver(): SpeechDriver {
  const synth = window.speechSynthesis;
  let voicesCache: SpeechSynthesisVoice[] = [];
  const voiceFor = (uri: string | null): SpeechSynthesisVoice | null => {
    if (!uri) return null;
    if (!voicesCache.length) voicesCache = synth.getVoices();
    return voicesCache.find((v) => v.voiceURI === uri) ?? null;
  };
  return {
    speak(text, opts, onDone) {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = clampRate(opts.rate);
      const v = voiceFor(opts.voiceURI);
      if (v) u.voice = v;
      u.onend = () => onDone();
      u.onerror = () => onDone();
      synth.speak(u);
    },
    cancel: () => synth.cancel(),
    pause: () => synth.pause(),
    resume: () => synth.resume(),
  };
}
