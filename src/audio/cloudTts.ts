// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Rust-synth speech driver: a `SpeechDriver` (see `speech.ts`) that synthesizes
// each streamed sentence through the Rust `tts_synth` command and plays the
// returned audio through the Web Audio API, in order. `tts_synth` resolves the
// engine server-side, so this one driver serves BOTH the cloud premium voices
// (OpenAI, ElevenLabs) and the local Kokoro voice — identical on the frontend.
//
// What keeps the spoken stream tight, and stoppable:
//   1. READ-AHEAD — a sentence starts synthesizing before playback reaches it,
//      so the next clip is usually ready when the current one ends; but never
//      more than `READ_AHEAD` sentences beyond the one in hand. Kokoro
//      synthesizes one request at a time, so everything requested is a queue the
//      next reply waits behind: "Read the plan" once requested all ~950
//      sentences of a long plan at once.
//   2. GENERATIONS — `cancel()` (Stop, barge-in, the next turn) starts a new
//      generation and tells Rust (`tts_cancel`) to drop the old one's requests
//      that haven't reached an engine. A clip from an old generation is never
//      played, and its `onDone` never lands on the next turn's count.
//   3. NOTHING WEDGES — a clip whose 'ended' never fires is let go after its
//      length plus `CLIP_GRACE_MS`; a context left suspended (⏸ then Stop) or
//      interrupted by the system is resumed; a clip that throws costs only that
//      sentence; a sentence the engine fails on is read by the system voice.
//   4. SILENCE TRIM — engines pad clips with leading/trailing quiet, which reads
//      as a gap between back-to-back sentences. We play only the non-silent span.
//
// Kept out of `speech.ts` so that file stays free of Tauri imports and remains
// unit-testable under node; the audio path here only runs in the webview.

import { invoke } from "@tauri-apps/api/core";

import { clampRate, type SpeechDriver } from "./speech";

interface TtsAudio {
  audioBase64: string;
  mime: string;
  /** The speed already rendered into the audio: Kokoro takes the user's speed
   *  itself, the cloud engines come back at 1. */
  speed: number;
}

/** Sentences that may be synthesizing (or synthesized and waiting) beyond the
 *  one in hand. */
export const READ_AHEAD = 2;
/** How long past its own length a clip may go without 'ended' before playback
 *  counts as stuck and moves on. */
export const CLIP_GRACE_MS = 1500;
/** What `tts_synth` answers for a request whose generation was cancelled:
 *  expected, never a failure to report. */
const CANCELLED = "cancelled";
/** What the settings ▶ says in a voice being auditioned. */
const VOICE_SAMPLE =
  "Here's how I'll sound reading your plan back to you. Tell me what to change, and we'll work through it.";

// Generations are unique across every driver in the app, because `tts_cancel`
// is app-wide: cancelling the voice panel's reply must never drop a chat's read
// aloud. Seeding from the clock keeps two windows' counters apart as well.
let lastGeneration = Date.now();
const nextGeneration = () => ++lastGeneration;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Non-silent span of a clip, as a `start(when, offset, duration)` pair. Engines
 *  pad clips with quiet at both ends; trimming it removes the inter-sentence gap.
 *  A small pad keeps soft onsets/tails from being clipped. */
function trimBounds(buf: AudioBuffer): { offset: number; duration: number } {
  const data = buf.getChannelData(0);
  const thresh = 0.005; // ~-46 dBFS
  let start = 0;
  let end = data.length - 1;
  while (start < data.length && Math.abs(data[start]) < thresh) start++;
  while (end > start && Math.abs(data[end]) < thresh) end--;
  if (end <= start) return { offset: 0, duration: 0 }; // effectively silent
  const pad = Math.floor(buf.sampleRate * 0.012);
  start = Math.max(0, start - pad);
  end = Math.min(data.length - 1, end + pad);
  return {
    offset: start / buf.sampleRate,
    duration: (end - start) / buf.sampleRate,
  };
}

/** A synthesized sentence, decoded. */
interface Clip {
  audio: AudioBuffer;
  speed: number;
}

/** A sentence being heard. `done` settles once — when it ends, is stopped, or
 *  its watchdog gives up on it — so nothing waiting on it can hang. */
interface Playing {
  done: Promise<void>;
  stop(): void;
  /** ⏸: paused time doesn't count against the watchdog. */
  hold(): void;
  /** ▶: re-arms the watchdog with the full allowance, never less than is left. */
  release(): void;
}

/** Start something audible and watch it: `begin` starts it and calls `ended`
 *  when it finishes; if that hasn't happened `limitMs` after it was (re)armed,
 *  it is stopped and treated as finished. `begin` may throw. */
function watched(
  limitMs: number,
  begin: (ended: () => void) => { stop(): void; hold?(): void; release?(): void },
): Playing {
  let settled = false;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle();
  };
  const handle = begin(finish);
  const arm = () => {
    clearTimeout(timer);
    if (settled) return;
    timer = setTimeout(() => {
      console.warn("[tts] a clip never reported its end; moving on");
      handle.stop();
      finish();
    }, limitMs);
  };
  arm();
  return {
    done,
    stop: () => {
      handle.stop();
      finish();
    },
    hold: () => {
      clearTimeout(timer);
      handle.hold?.();
    },
    release: () => {
      handle.release?.();
      arm();
    },
  };
}

/** Play the non-silent span of `clip` at the user's `rate`; null for a clip
 *  with nothing audible in it. */
function playClip(ctx: AudioContext, clip: Clip, rate: number): Playing | null {
  const { offset, duration } = trimBounds(clip.audio);
  if (duration <= 0) return null;
  // Kokoro has already rendered the user's speed, which keeps the pitch; for an
  // engine that couldn't, `playbackRate` makes up the difference (shifting the
  // pitch, which is fine in the 0.5–2× range).
  const playbackRate = clampRate(rate) / (clip.speed || 1);
  return watched((duration / playbackRate) * 1000 + CLIP_GRACE_MS, (ended) => {
    const src = ctx.createBufferSource();
    src.buffer = clip.audio;
    src.playbackRate.value = playbackRate;
    src.connect(ctx.destination);
    src.onended = ended;
    src.start(0, offset, duration);
    return {
      stop: () => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      },
    };
  });
}

/** The system voice reading one sentence: the stand-in when the engine failed
 *  on it, so a reply keeps talking instead of going quiet. Null where there is
 *  no system voice. */
function speakWithSystemVoice(text: string, rate: number): Playing | null {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return null;
  const r = clampRate(rate);
  // ~15 characters a second at 1×; twice that before calling it stuck.
  return watched((text.length / 15 / r) * 2000 + CLIP_GRACE_MS, (ended) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = r;
    u.onend = ended;
    u.onerror = ended;
    synth.speak(u);
    return {
      stop: () => synth.cancel(),
      hold: () => synth.pause(),
      release: () => synth.resume(),
    };
  });
}

/** A `SpeechDriver` backed by the Rust `tts_synth` command + Web Audio playback.
 *  `onError` (optional) is called with the failure message when a sentence fails
 *  to synthesize — once per problem, not once per sentence, since a failing
 *  engine fails every sentence the same way. The sentence itself is read by the
 *  system voice. The Rust side also logs the real provider response (HTTP status
 *  + body) at `error` level. */
export function cloudTtsDriver(onError?: (msg: string) => void): SpeechDriver {
  let ctx: AudioContext | null = null;
  const audioCtx = () => (ctx ??= new AudioContext());

  type Item = {
    text: string;
    rate: number;
    onDone: () => void;
    /** Started by the read-ahead, or when the item's turn comes. */
    clip?: Promise<Clip | null>;
  };
  let queue: Item[] = [];
  let generation = nextGeneration();
  // Whether this generation has asked Rust for anything, i.e. whether a cancel
  // has anything there to drop.
  let requested = false;
  // The generation whose run loop is live (0 = none).
  let loop = 0;
  // What wakes that loop out of an await when its generation is cancelled: one
  // per await, dropped once the awaited thing settles. A single long-lived
  // "cancelled" promise raced against each await would keep everything ever
  // raced with it reachable until the next cancel, and a long read is
  // hundreds of decoded clips with no cancel in between.
  const wakers = new Set<() => void>();
  const unlessCancelled = <T>(p: Promise<T>) =>
    new Promise<T | null>((resolve) => {
      const wakeUp = () => resolve(null);
      wakers.add(wakeUp);
      void p.then(resolve, () => resolve(null)).finally(() => wakers.delete(wakeUp));
    });
  let current: Playing | null = null;
  let paused = false;
  let lastError = "";

  /** Resume a context that isn't running — left suspended by ⏸ then Stop, or
   *  interrupted by the system — unless the user has paused on purpose. A
   *  closed one is replaced on next use. */
  const wake = () => {
    if (!ctx || paused) return;
    if (ctx.state === "closed") ctx = null;
    else if (ctx.state !== "running") void ctx.resume().catch(() => {});
  };

  /** Null when the engine failed on it (the system voice reads it instead) or
   *  when its generation was cancelled (nobody plays it). */
  const synth = async (text: string, rate: number, gen: number): Promise<Clip | null> => {
    requested = true;
    try {
      const res = await invoke<TtsAudio>("tts_synth", {
        text,
        generation: gen,
        speed: clampRate(rate),
      });
      if (gen !== generation) return null;
      // `decodeAudioData` detaches the buffer, so hand it a fresh ArrayBuffer.
      const bytes = base64ToBytes(res.audioBase64);
      const audio = await audioCtx().decodeAudioData(bytes.buffer as ArrayBuffer);
      lastError = "";
      return { audio, speed: res.speed || 1 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (gen === generation && msg !== CANCELLED) {
        console.error("[tts] synth failed:", msg);
        if (msg !== lastError) onError?.(msg);
        lastError = msg;
      }
      return null;
    }
  };

  /** Start synthesizing what playback reaches next — never more than
   *  `READ_AHEAD` sentences past the one in hand. */
  const fill = () => {
    for (const item of queue.slice(0, READ_AHEAD)) {
      item.clip ??= synth(item.text, item.rate, generation);
    }
  };

  // One loop per generation, and it exits the moment that generation is
  // cancelled: a cancelled reply's sentence must not be played into the next.
  const run = async () => {
    if (loop === generation) return;
    const gen = (loop = generation);
    const live = () => gen === generation;
    try {
      while (live() && queue.length) {
        const item = queue.shift()!;
        const pending = (item.clip ??= synth(item.text, item.rate, gen));
        fill();
        const clip = await unlessCancelled(pending);
        if (!live()) return;
        let playing: Playing | null = null;
        try {
          wake();
          playing = clip
            ? playClip(audioCtx(), clip, item.rate)
            : speakWithSystemVoice(item.text, item.rate);
          current = playing;
          if (playing) {
            if (paused) playing.hold();
            await unlessCancelled(playing.done);
          }
        } catch (e) {
          // A clip that can't be played costs that one sentence, never the queue.
          console.error("[tts] playback failed:", e);
        } finally {
          if (current === playing) current = null;
        }
        if (live()) item.onDone();
      }
    } finally {
      if (loop === gen) loop = 0;
    }
  };

  return {
    speak(text, opts, onDone) {
      queue.push({ text, rate: opts.rate, onDone });
      wake();
      fill();
      void run();
    },
    cancel() {
      const cancelled = generation;
      generation = nextGeneration();
      queue = [];
      for (const wakeUp of wakers) wakeUp();
      wakers.clear();
      current?.stop();
      current = null;
      // ⏸ then Stop must not leave the context suspended: every later clip
      // would start, never end, and keep the queue "speaking" for good.
      paused = false;
      wake();
      if (requested) void invoke("tts_cancel", { generation: cancelled }).catch(() => {});
      requested = false;
    },
    pause() {
      paused = true;
      // Made here if no clip has needed one yet: a clip still synthesizing
      // must start on a suspended context, not play under ⏸.
      void audioCtx().suspend().catch(() => {});
      current?.hold();
    },
    resume() {
      paused = false;
      wake();
      current?.release();
    },
  };
}

let sampleCtx: AudioContext | null = null;

/** The settings ▶: synthesize a sample sentence in Kokoro `voice` (one the user
 *  is auditioning, not necessarily the saved one) at `rate`, and play it.
 *  Returns a stop that also drops the request in Rust if it hasn't reached the
 *  engine. `onEnd` is called once it has played, or with the error if it
 *  couldn't be; never after stop. */
export function playVoiceSample(
  voice: string,
  rate: number,
  onEnd: (error?: string) => void,
): () => void {
  const generation = nextGeneration();
  let stopped = false;
  let playing: Playing | null = null;
  void (async () => {
    try {
      const res = await invoke<TtsAudio>("tts_synth", {
        text: VOICE_SAMPLE,
        generation,
        speed: clampRate(rate),
        voice,
      });
      if (stopped) return;
      const ctx = (sampleCtx ??= new AudioContext());
      if (ctx.state !== "running") await ctx.resume();
      const bytes = base64ToBytes(res.audioBase64);
      const audio = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
      if (stopped) return;
      playing = playClip(ctx, { audio, speed: res.speed || 1 }, rate);
      await playing?.done;
      if (!stopped) onEnd();
    } catch (e) {
      if (!stopped) onEnd(e instanceof Error ? e.message : String(e));
    }
  })();
  return () => {
    if (stopped) return;
    stopped = true;
    playing?.stop();
    void invoke("tts_cancel", { generation }).catch(() => {});
  };
}
