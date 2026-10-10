// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The studio voice's speech driver: a `SpeechDriver` (see `speech.ts`) that
// streams each piece of a reply from the local Qwen3-TTS sidecar
// (`tts_studio.rs`) and plays its audio as it arrives, about 0.1 s after the
// text goes out. Its own chunk, loaded only when the studio voice is the
// engine.
//
// What it does that the clip-at-a-time driver in cloudTts.ts doesn't:
//   1. ONE TIMELINE — every frame (24 kHz PCM16 on the piece's Channel) is
//      scheduled back to back on a 24 kHz context of its own: no resampler
//      seams between chunks, and a 100 ms cushion only where the timeline ran
//      dry. The timeline is also exactly what has been heard (`heard`), which
//      the "you were interrupted after saying …" note quotes.
//   2. FLOW CONTROL — at most `READ_AHEAD` pieces at the sidecar beyond the one
//      playing, so a long read is synthesized as it is heard, not minutes ahead.
//   3. SHORT PIECES JOIN — a piece under `SHORT` characters waits up to
//      `HOLD_MS` for the next one and goes with it: alone, "Sure." runs on into
//      noise in 7–20% of reads; joined, in none of 30. The sentences in it
//      still finish one by one — the first when the piece starts sounding — so
//      the queue and playback.ts keep their clip-per-sentence view.
//   4. GENERATIONS — from the app-wide counter, so `tts_cancel` stops exactly
//      this driver's speech; a frame whose header names another generation, or
//      one for a piece already let go, is dropped.
//   5. A STAND-IN — Kokoro when it is installed, else the system voice:
//
//      | when                                                  | the stand-in reads |
//      |-------------------------------------------------------|--------------------|
//      | the model isn't warm at the reply's first piece       | the whole reply    |
//      | a refusal, or any error but `empty_text`              | the rest of it     |
//      | a second length-cap hit in one reply                  | the rest of it     |
//      | an unload under memory pressure                       | until pressure has been normal for 60 s |
//
//      `empty_text` (nothing speakable) just finishes the piece. Every new
//      reply tries the studio voice again; `onFallback` says why it didn't, for
//      a quiet chip, and null once it speaks again.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { CLIP_GRACE_MS, cloudTtsDriver, nextGeneration, READ_AHEAD } from "./cloudTts";
import { browserSpeechDriver, type SpeechDriver } from "./speech";

/** The studio voice's preset speakers offered in settings (the model has nine;
 *  these three read English best in the spike's jargon and pace checks). */
export const STUDIO_VOICES = [
  { id: "ryan", name: "Ryan", kind: "male, warm" },
  { id: "aiden", name: "Aiden", kind: "male, lighter" },
  { id: "serena", name: "Serena", kind: "female" },
] as const;

/**
 * Tone words, each with the ONE instruction that moved the 1.7B CustomVoice
 * model the same way in at least 9 of 10 seeded reads against the same seeds
 * read plainly, by more than the plain reads' own spread (5 seeds × 2
 * sentences, preset ryan; the spike's instruct check, 2026-10-10): slow and
 * gentle lengthen the read, brisk shortens it, calm and gentle flatten the
 * pitch's movement, upbeat and excited raise it. Whisper heard 58 of these 60
 * reads word for word. Serious, soft and warm moved nothing consistently in
 * any phrasing tried, so they — like any word not here — read plainly.
 */
export const STUDIO_TONES: Record<string, { label: string; instruct: string }> = {
  calm: { label: "Calm", instruct: "Speak calmly, in a low and relaxed voice." },
  gentle: { label: "Gentle", instruct: "Speak gently and slowly." },
  slow: { label: "Slow", instruct: "Speak very slowly." },
  brisk: { label: "Brisk", instruct: "Speak quickly." },
  upbeat: { label: "Upbeat", instruct: "Speak in an upbeat, cheerful voice." },
  excited: { label: "Excited", instruct: "Speak with excitement." },
};

/** The instruction for a tone ("calm, upbeat"): its first word with one. */
export function toneInstruction(tone: string | null | undefined): string | undefined {
  for (const word of (tone ?? "").split(/[\s,]+/)) {
    const hit = STUDIO_TONES[word]?.instruct;
    if (typeof hit === "string") return hit;
  }
  return undefined;
}

/** Shorter pieces wait to be joined to the next. */
export const SHORT = 16;
/** …for at most this long. */
export const HOLD_MS = 250;
/** The cushion before audio when the timeline has run dry. */
export const JITTER_S = 0.1;
/** No audio for this long from the piece the sidecar is on: stalled. Rust
 *  gives up first (1.5 s, or 4 s while loading or between chunks); this is
 *  for an answer that never comes at all. */
export const SYNTH_LIMIT_MS = 8000;
/** After an unload under memory pressure, how long `status` must say
 *  "normal" before the studio voice speaks again, and how often it is asked. */
export const CALM_MS = 60_000;
const CALM_POLL_MS = 10_000;
const SAMPLE_RATE = 24000;
/** The reply's first piece streams in smaller chunks: first audio sooner. */
const FIRST_INTERVAL = 0.16;
/** The studio voice's pace, to place a cut in a piece not all here yet. */
const CHARS_PER_SECOND = 16;

/** Frame header flags (tts_studio.rs). */
const FINAL = 1;
const CANCELLED = 2;
const ERROR = 4;

type Reason = "warming" | "stalled" | "caps" | "memory" | "disabled" | "missing";

// --- The sidecar, as every driver in this window sees it ----------------------

interface StudioStatus {
  installed: boolean;
  state: string;
  reason: string | null;
  pressure: number | null;
}

/** From `status`, then `studio-status` events. `squeezed` keeps the
 *  stand-in on after an unload under memory pressure. A waiter hears each
 *  state, and whether an event brought it (news) or `status` did. */
const studio = {
  known: false,
  installed: false,
  state: "off",
  squeezed: false,
  waiters: new Set<(state: string, news: boolean) => void>(),
};
let watching = false;

function noteState(state: string, reason: string | null, news: boolean) {
  studio.state = state === "exited" ? "off" : state;
  // A model loading is installed (an install just ended, perhaps); a
  // removal is not.
  if (state === "loading" || state === "ready") studio.installed = true;
  if (reason === "removed") studio.installed = false;
  if (state === "unloaded" && reason === "memory_pressure") squeeze();
  for (const wake of [...studio.waiters]) wake(state, news);
}

function readStatus() {
  void invoke<StudioStatus>("tts_studio", { op: "status" })
    .then((s) => {
      studio.known = true;
      studio.installed = s.installed;
      noteState(s.state, s.reason, false);
    })
    .catch(() => {});
}

/** Start following the sidecar (once). */
export function watchStudio(): void {
  if (watching) return;
  watching = true;
  void listen<{ state: string; reason: string | null }>("studio-status", (e) =>
    noteState(e.payload.state, e.payload.reason, true),
  ).catch(() => {});
  readStatus();
}

function squeeze() {
  if (studio.squeezed) return;
  studio.squeezed = true;
  let calmSince = 0;
  const poll = () =>
    setTimeout(() => {
      void invoke<StudioStatus>("tts_studio", { op: "status" })
        .then((s) => {
          if ((s.pressure ?? 1) >= 2) calmSince = 0;
          else calmSince ||= Date.now();
          if (calmSince && Date.now() - calmSince >= CALM_MS) studio.squeezed = false;
          else poll();
        })
        .catch(() => {
          studio.squeezed = false;
        });
    }, CALM_POLL_MS);
  poll();
}

/** What a refusal or a failed piece says, for this reply and the next. */
function reasonFor(code: string): Reason {
  if (code === "memory_pressure") {
    squeeze();
    return "memory";
  }
  if (code === "studio_not_installed") {
    studio.installed = false;
    return "missing";
  }
  if (code === "studio_disabled") {
    studio.state = "disabled";
    return "disabled";
  }
  return "stalled";
}

/** Load the model ahead of speech: a voice surface opened, the Discuss pill
 *  was hovered, a reply began. Rust ignores it unless studio is the engine,
 *  or `always` (a preview before the engine is saved). */
export function warmStudio(always = false): Promise<void> {
  return invoke<void>("tts_studio", { op: "warm", args: { always } }).catch((e) => {
    reasonFor(String(e));
    throw e;
  });
}

/** A voice surface opened or closed: five minutes after the last one closes
 *  the sidecar is stopped. */
export function studioSurface(surface: string, open: boolean): void {
  void invoke("tts_studio", { op: "surface", args: { surface, open } }).catch(() => {});
}

/** Why the studio voice can't take a reply starting now, if it can't. */
function unready(): Reason | null {
  if (studio.state === "disabled") return "disabled";
  if (studio.known && !studio.installed) return "missing";
  if (studio.squeezed) return "memory";
  return studio.state === "ready" ? null : "warming";
}

// --- The driver ----------------------------------------------------------------

/** A sentence the queue handed over, and its `onDone`. */
interface Part {
  text: string;
  done: () => void;
  over: boolean;
}

/** One request to the sidecar: a sentence, or short ones joined. */
interface Piece {
  parts: Part[];
  rate: number;
  voiceURI: string | null;
  tone: string | null;
  route: "studio" | "standin";
  first: boolean;
  /** Asked of the sidecar, or handed to the stand-in. */
  sent: boolean;
  /** The sidecar's last frame for it came: its audio is all here. */
  final: boolean;
  /** Its generation, once sent. */
  gen: number;
  /** Let go of (a cancel): whatever still arrives for it goes nowhere. */
  gone: boolean;
  /** Frames waiting for every piece ahead to have all its audio scheduled. */
  held: Float32Array[];
  sources: AudioBufferSourceNode[];
  /** Its span on the timeline, context seconds; `start` is -1 before audio. */
  start: number;
  end: number;
}

const textOf = (p: Piece) => p.parts.map((s) => s.text).join(" ");

function finishPart(s: Part) {
  if (s.over) return;
  s.over = true;
  s.done();
}

export interface StudioOptions {
  /** A stand-in voice's synthesis failed (cloudTts.ts). */
  onError?: (msg: string) => void;
  /** Why the stand-in is reading this reply; null when the studio voice is. */
  onFallback?: (note: string | null) => void;
  /** The tone of a reply without a ⟦tone⟧: the saved style. */
  style?: string;
  /** Speak in this preset instead of the saved one: a settings preview. It
   *  never hands over to a stand-in — it waits for the model to be warm, and a
   *  failure goes to `onError`. */
  preview?: string;
}

export function studioTtsDriver(opts: StudioOptions = {}): SpeechDriver {
  watchStudio();
  // The stand-in: Kokoro, in the user's voice for it, when it is set up.
  let kokoro: string | null = null;
  if (!opts.preview) {
    void Promise.all([
      invoke<{ modelPresent: boolean; pythonReady: boolean }>("tts_kokoro_status"),
      invoke<{ kokoroVoice?: string }>("tts_get_settings"),
    ])
      .then(([k, s]) => {
        if (k.modelPresent && k.pythonReady) kokoro = s.kokoroVoice || "af_heart";
      })
      .catch(() => {});
  }
  let standin: SpeechDriver | null = null;
  const standinDriver = () => {
    if (!standin) {
      standin = kokoro ? cloudTtsDriver(opts.onError, kokoro) : browserSpeechDriver();
      if (paused) standin.pause();
    }
    return standin;
  };

  let ctx: AudioContext | null = null;
  let next = 0;
  const audio = () => {
    if (!ctx) {
      try {
        ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      } catch {
        ctx = new AudioContext(); // the buffers stay 24 kHz; their sources resample
      }
      next = 0;
    }
    return ctx;
  };
  let pieces: Piece[] = [];
  let held: Piece | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let synthTimer: ReturnType<typeof setTimeout> | undefined;
  let synthWatched: Piece | null = null;
  let playTimer: ReturnType<typeof setTimeout> | undefined;
  let warmWaiter: ((state: string, news: boolean) => void) | null = null;
  let generation = nextGeneration();
  let requested = false;
  let paused = false;
  // The reply being spoken. Decided at its first piece, not when it began, so
  // a warm-up started with the turn has the agent's thinking time to finish.
  const freshTurn = () => ({ decided: false, standin: null as Reason | null, caps: 0, first: true });
  let turn = freshTurn();

  const chip = (why: Reason) => {
    const who = kokoro ? "Kokoro" : "System voice";
    switch (why) {
      case "warming":
        return `Studio voice warming · ${who} reading`;
      case "memory":
        return `Memory tight · ${who} reading`;
      case "disabled":
        return `Studio voice crashed twice · ${who} reading`;
      case "missing":
        return `Studio voice not installed · ${who} reading`;
      case "caps":
        return `Studio voice ran on · ${who} finishing`;
      case "stalled":
        return `Studio voice stalled · ${who} finishing`;
    }
  };

  const decide = () => {
    if (turn.decided || opts.preview) return;
    turn.decided = true;
    const why = unready();
    if (why === "warming") void warmStudio().catch(() => {});
    // Installed since this window last asked? The next reply will know.
    if (why === "missing") readStatus();
    turn.standin = why;
    opts.onFallback?.(why && chip(why));
  };

  // The rest of the reply goes to the stand-in: every piece whose audio isn't
  // all here, and everything after it. The sidecar drops what it still holds
  // of this generation; what comes next gets a new one.
  const fallBack = (why: Reason) => {
    if (turn.standin === null) opts.onFallback?.(chip(why));
    turn.standin ??= why;
    let asked = false;
    for (const p of pieces) {
      if (p.route !== "studio" || p.final) continue;
      asked ||= p.sent;
      p.route = "standin";
      p.sent = false;
      p.held = [];
    }
    if (asked) {
      void invoke("tts_cancel", { generation }).catch(() => {});
      generation = nextGeneration();
    }
  };

  /** A piece the sidecar refused or gave up on. */
  const failed = (p: Piece, code: string) => {
    if (opts.preview) {
      opts.onError?.(code);
      p.final = true;
    } else {
      fallBack(reasonFor(code));
    }
    settle();
  };

  const stop = (s: AudioBufferSourceNode) => {
    try {
      s.stop();
    } catch {
      /* never started, or already stopped */
    }
  };

  const play = (p: Piece, pcm: Float32Array) => {
    const c = audio();
    if (c.state === "suspended" && !paused) void c.resume().catch(() => {});
    const buf = c.createBuffer(1, pcm.length, SAMPLE_RATE);
    buf.getChannelData(0).set(pcm);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.onended = () => {
      p.sources = p.sources.filter((s) => s !== src);
      if (!p.gone) settle();
    };
    // Back to back while the timeline is ahead of the clock; where it ran
    // dry, a cushion so the next frame's jitter doesn't open a gap.
    if (next < c.currentTime + 0.005) next = c.currentTime + JITTER_S;
    if (p.start < 0) {
      p.start = next;
      // It is sounding: every sentence in it but the last is "spoken".
      for (const s of p.parts.slice(0, -1)) finishPart(s);
    }
    src.start(next);
    next += buf.duration;
    p.end = next;
    p.sources.push(src);
  };

  // Frames go on the timeline in order: a piece's once every piece ahead has
  // all of its own there. The stand-in isn't on the timeline, so studio audio
  // behind it waits for it to finish.
  const drain = () => {
    for (const p of pieces) {
      if (p.route !== "studio") return;
      for (const pcm of p.held.splice(0)) play(p, pcm);
      if (!p.final) return;
    }
  };

  const onFrame = (p: Piece, data: ArrayBuffer) => {
    if (p.gone || p.route !== "studio" || p.final || data.byteLength < 12) return;
    const head = new DataView(data, 0, 12);
    if (head.getUint32(0, true) !== p.gen >>> 0) return;
    const flags = head.getUint16(8, true);
    if (!(flags & FINAL)) {
      const pcm = new Int16Array(data, 12, (data.byteLength - 12) >> 1);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      p.held.push(f);
      drain();
      armSynth(true);
      return;
    }
    let outcome: { code?: string; stats?: { caps_hit?: number; cap_hit?: boolean } } = {};
    try {
      outcome = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 12)));
    } catch {
      /* an outcome is always JSON; anything else counts as an error */
    }
    // Cancelled here are let go of first; one cancelled anywhere else, like an
    // error, leaves the stand-in to say it.
    if (flags & (ERROR | CANCELLED) && outcome.code !== "empty_text") {
      failed(p, outcome.code ?? "error");
      return;
    }
    p.final = true;
    const caps = outcome.stats?.caps_hit ?? (outcome.stats?.cap_hit ? 1 : 0);
    if ((turn.caps += caps) >= 2) fallBack("caps");
    settle();
  };

  const send = (p: Piece) => {
    p.sent = true;
    p.gen = generation;
    requested = true;
    const onAudio = new Channel<ArrayBuffer>();
    onAudio.onmessage = (data) => onFrame(p, data);
    const args = {
      text: textOf(p),
      generation: p.gen,
      voice: opts.preview,
      instruct: toneInstruction(p.tone) ?? toneInstruction(opts.style),
      interval: p.first ? FIRST_INTERVAL : undefined,
    };
    void invoke("tts_studio", { op: "speak", args, onAudio }).catch((e) => {
      if (!p.gone && p.route === "studio" && !p.final) failed(p, String(e));
    });
  };

  // Rust's watchdog ends a piece the sidecar sits on; this one is for an
  // answer that never arrives at all, so nothing waits forever.
  const armSynth = (fresh = false) => {
    const p = pieces.find((q) => q.route === "studio" && q.sent && !q.final) ?? null;
    if (p === synthWatched && !fresh) return;
    clearTimeout(synthTimer);
    synthWatched = p;
    if (p) synthTimer = setTimeout(() => synthWatched === p && failed(p, "stalled"), SYNTH_LIMIT_MS);
  };

  // Audio whose 'ended' never fires (a context the system stopped) is let go
  // of after its scheduled end plus the grace; paused time doesn't count.
  const armPlay = () => {
    clearTimeout(playTimer);
    const p = pieces[0];
    if (paused || !ctx || !p || p.route !== "studio" || !p.final || !p.sources.length) return;
    const left = Math.max(0, p.end - ctx.currentTime) * 1000;
    playTimer = setTimeout(() => {
      console.warn("[tts] studio audio never reported its end; moving on");
      for (const s of p.sources) stop(s);
      p.sources = [];
      settle();
    }, left + CLIP_GRACE_MS);
  };

  // A preview speaks only into a warm model: a cold one loads past the
  // sidecar's 4 s allowance for a first chunk. One that can't warm fails.
  const warmFirst = () => {
    if (!opts.preview || studio.state === "ready") return false;
    if (!warmWaiter) {
      const stopWaiting = () => {
        if (warmWaiter) studio.waiters.delete(warmWaiter);
        warmWaiter = null;
      };
      const giveUp = (code: string) => {
        stopWaiting();
        for (const p of pieces) if (!p.final) failed(p, code);
      };
      warmWaiter = (state, news) => {
        if (state === "ready") {
          stopWaiting();
          settle();
        } else if (state === "disabled" || (news && (state === "off" || state === "exited"))) {
          giveUp("sidecar_exited");
        }
      };
      studio.waiters.add(warmWaiter);
      // Already warm sends no event: ask once the warm-up is under way.
      warmStudio(true).then(readStatus, (e) => giveUp(String(e)));
    }
    return true;
  };

  // The one loop: finish what has played, in order; put waiting audio on the
  // timeline; hand the stand-in what has reached it; ask the sidecar for more.
  const settle = () => {
    while (pieces.length) {
      const p = pieces[0];
      const over =
        p.route === "studio"
          ? p.final && !p.held.length && !p.sources.length
          : p.parts.every((s) => s.over);
      if (!over) break;
      pieces.shift();
      for (const s of p.parts) finishPart(s);
    }
    drain();
    for (const p of pieces) {
      if (p.route !== "standin" || p.sources.length) break;
      if (p.sent) continue;
      p.sent = true;
      for (const s of p.parts) {
        if (s.over) continue;
        standinDriver().speak(s.text, { rate: p.rate, voiceURI: p.voiceURI }, () => {
          if (p.gone) return;
          finishPart(s);
          settle();
        });
      }
    }
    if (!warmFirst()) {
      let asked = pieces.filter((p) => p.route === "studio" && p.sent).length;
      for (const p of pieces) {
        if (asked > READ_AHEAD) break;
        if (p.route !== "studio" || p.sent) continue;
        send(p);
        asked += 1;
      }
    }
    armSynth();
    armPlay();
  };

  const release = () => {
    clearTimeout(holdTimer);
    const p = held;
    if (!p) return;
    held = null;
    if (turn.standin) p.route = "standin";
    pieces.push(p);
    settle();
  };

  return {
    speak(text, o, onDone) {
      decide();
      const part = { text, done: onDone, over: false };
      if (held) {
        held.parts.push(part);
        if (textOf(held).length >= SHORT) release();
        return;
      }
      const studioTurn = !turn.standin;
      const p: Piece = {
        parts: [part],
        rate: o.rate,
        voiceURI: o.voiceURI,
        tone: o.tone ?? null,
        route: studioTurn ? "studio" : "standin",
        first: studioTurn && turn.first,
        sent: false,
        final: false,
        gen: 0,
        gone: false,
        held: [],
        sources: [],
        start: -1,
        end: -1,
      };
      if (studioTurn) turn.first = false;
      if (studioTurn && text.length < SHORT) {
        held = p;
        holdTimer = setTimeout(release, HOLD_MS);
        return;
      }
      pieces.push(p);
      settle();
    },
    cancel() {
      clearTimeout(holdTimer);
      clearTimeout(synthTimer);
      clearTimeout(playTimer);
      synthWatched = null;
      if (warmWaiter) studio.waiters.delete(warmWaiter);
      warmWaiter = null;
      for (const p of pieces) {
        p.gone = true;
        for (const s of p.sources) stop(s);
      }
      pieces = [];
      held = null;
      if (requested) void invoke("tts_cancel", { generation }).catch(() => {});
      requested = false;
      generation = nextGeneration();
      standin?.cancel();
      paused = false;
      // The next reply gets a fresh context, never one ⏸ left suspended.
      void ctx?.close().catch(() => {});
      ctx = null;
      turn = freshTurn();
    },
    pause() {
      paused = true;
      clearTimeout(playTimer);
      // Made now if nothing has played yet: audio still on its way must start
      // on a suspended context, not under ⏸.
      void audio().suspend().catch(() => {});
      standin?.pause();
    },
    resume() {
      paused = false;
      void ctx?.resume().catch(() => {});
      standin?.resume();
      armPlay();
    },
    beginTurn() {
      release();
      turn = freshTurn();
      if (unready() === "warming") void warmStudio().catch(() => {});
    },
    flush: () => release(),
    heard() {
      const p = pieces[0];
      if (!p || p.route !== "studio") return null;
      if (!ctx || p.start < 0 || ctx.currentTime <= p.start) return "";
      // The time heard is exact; where the words fall in it, proportional.
      const text = textOf(p);
      const span = p.final
        ? p.end - p.start
        : Math.max(p.end - p.start, text.length / CHARS_PER_SECOND);
      const at = Math.floor((text.length * (ctx.currentTime - p.start)) / span);
      if (at >= text.length) return text;
      const cut = text.lastIndexOf(" ", at);
      return cut > 0 ? text.slice(0, cut) : "";
    },
  };
}

/** A sample in preset `voice` (the settings ▶, and "Studio voice ready." after
 *  an install), waiting for the model if it is still loading. `onEnd` gets the
 *  failure's code if it failed; never after the returned stop. */
export function playStudioSample(
  voice: string,
  text: string,
  onEnd: (error?: string) => void,
): () => void {
  let error: string | undefined;
  let stopped = false;
  const d = studioTtsDriver({ preview: voice, onError: (e) => (error ??= e) });
  d.speak(text, { rate: 1, voiceURI: null }, () => {
    if (!stopped) onEnd(error);
  });
  d.flush?.();
  return () => {
    stopped = true;
    d.cancel();
  };
}
