// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Rust-synth speech driver: a `SpeechDriver` (see `speech.ts`) that synthesizes
// each streamed sentence through the Rust `tts_synth` command and plays the
// returned audio through the Web Audio API, in order. `tts_synth` resolves the
// engine server-side, so this one driver serves BOTH the cloud premium voice
// (OpenAI) and the local Kokoro voice — identical on the frontend.
//
// Two things keep the spoken stream tight despite each clip being a round-trip:
//   1. EAGER synthesis — a sentence starts synthesizing the instant it's known
//      (in `speak`), not when playback reaches it. So while one clip plays, every
//      sentence already queued (and every new one that arrives) is synthesizing
//      in parallel; by the time we need it, it's usually ready. Playback order is
//      still preserved because the run loop awaits each clip's promise in turn.
//   2. SILENCE TRIM — engines pad clips with leading/trailing quiet, which reads
//      as a gap between back-to-back sentences. We play only the non-silent span.
//
// Kept out of `speech.ts` so that file stays free of Tauri imports and remains
// unit-testable under node; the audio path here only runs in the webview.

import { invoke } from "@tauri-apps/api/core";

import { clampRate, type SpeechDriver } from "./speech";

interface TtsAudio {
  audioBase64: string;
  mime: string;
}

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

/** A `SpeechDriver` backed by the Rust `tts_synth` command + Web Audio playback.
 *  `onError` (optional) is called with the failure message whenever a sentence
 *  fails to synthesize — without it, a failure is silent silence and the user
 *  has no idea why the voice stopped. The Rust side also logs the real provider
 *  response (HTTP status + body) at `error` level. */
export function cloudTtsDriver(onError?: (msg: string) => void): SpeechDriver {
  let ctx: AudioContext | null = null;
  const audioCtx = () => (ctx ??= new AudioContext());

  // Each item carries its OWN in-flight synthesis promise — started at enqueue.
  type Item = { buf: Promise<AudioBuffer | null>; rate: number; onDone: () => void };
  let queue: Item[] = [];
  let running = false;
  let cancelled = false;
  let current: AudioBufferSourceNode | null = null;

  const synth = async (text: string): Promise<AudioBuffer | null> => {
    try {
      const res = await invoke<TtsAudio>("tts_synth", { text });
      const bytes = base64ToBytes(res.audioBase64);
      // `decodeAudioData` detaches the buffer, so hand it a fresh ArrayBuffer.
      return await audioCtx().decodeAudioData(bytes.buffer as ArrayBuffer);
    } catch (e) {
      // Still surfaced as silence for this sentence (the stream must continue),
      // but no longer silent about WHY — log it and report it upward.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[tts] synth failed:", msg);
      onError?.(msg);
      return null;
    }
  };

  const play = (audio: AudioBuffer, rate: number): Promise<void> =>
    new Promise((resolve) => {
      const { offset, duration } = trimBounds(audio);
      if (duration <= 0) {
        resolve();
        return;
      }
      const src = audioCtx().createBufferSource();
      src.buffer = audio;
      // The clip is rendered at normal speed; play it faster/slower to honor the
      // speed slider (this also shifts pitch, fine in the 0.5–2× range).
      src.playbackRate.value = clampRate(rate);
      src.connect(audioCtx().destination);
      current = src;
      src.onended = () => {
        if (current === src) current = null;
        resolve();
      };
      src.start(0, offset, duration);
    });

  const run = async () => {
    if (running) return;
    running = true;
    while (!cancelled) {
      const item = queue.shift();
      if (!item) break;
      const audio = await item.buf; // already synthesizing since enqueue
      if (cancelled) {
        item.onDone();
        break;
      }
      if (audio) await play(audio, item.rate);
      item.onDone();
    }
    running = false;
  };

  return {
    speak(text, opts, onDone) {
      cancelled = false;
      // Kick off synthesis immediately so it overlaps playback + arrival.
      queue.push({ buf: synth(text), rate: opts.rate, onDone });
      void run();
    },
    cancel() {
      cancelled = true;
      queue = [];
      if (current) {
        try {
          current.stop();
        } catch {
          /* already stopped */
        }
        current = null;
      }
    },
    pause() {
      void ctx?.suspend();
    },
    resume() {
      void ctx?.resume();
    },
  };
}
