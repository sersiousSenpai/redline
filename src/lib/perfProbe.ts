// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The responsiveness probe (docs/perf-budget.md "Responsiveness"): rolling
// input latency and frame pacing for the window this runs in, readable at
// `window.__rlPerf.snapshot()` and, from outside a release build that has no
// Web Inspector, at the daemon's `GET /v1/perf`.
//
// Three instruments, each degrading rather than lying:
//   - Input latency from the Event Timing API (the INP measure): for every
//     interaction, its slowest event's start-to-next-paint. The API only
//     reports events of 16 ms or more, so every keydown / pointerdown is also
//     counted here, and an interaction it never reported counts as the 16 ms
//     floor — percentiles over slow interactions alone would overstate.
//     Without the API, a fallback times each input to the end of the frame
//     after it, and the snapshot says it is approximate.
//   - Long tasks and long animation frames, where the engine has them (WebKit
//     has neither today; the snapshot says which were live, so an absent
//     instrument never reads as a clean zero).
//   - A requestAnimationFrame frame-gap histogram: the time between frames
//     while the user interacts with the visible page. Gaps over one refresh
//     interval are frames the main thread was too busy to produce. Input
//     starts the loop and it stops itself FRAME_TAIL_MS after the last one,
//     so an idle app requests no frames from the probe and an idle GPU /
//     renderer `sample` can be taken with it on.
//
// Bounded by construction: every series is a fixed-capacity ring, and nothing
// is retained past RETAIN_MS. Nothing leaves the page unless something asks.
// Started from main.tsx through `perfProbeSwitch.ts`, never imported eagerly.

/** Longest window a snapshot can summarize; older samples are dropped. */
export const RETAIN_MS = 120_000;
/** What a snapshot summarizes when the caller doesn't say. */
export const DEFAULT_WINDOW_MS = 60_000;
/** Event Timing's minimum `durationThreshold`: faster events go unreported. */
export const EVENT_FLOOR_MS = 16;
/** Frame-gap histogram bucket ceilings: a 120 Hz frame, a 60 Hz frame, one
 *  and two dropped 60 Hz frames, then the visible stalls. */
export const FRAME_BUCKETS_MS = [9, 17.5, 34, 50, 100, 250] as const;
/** How long the frame sampler runs on after the last input. */
export const FRAME_TAIL_MS = 2_000;

/** Input that wakes the frame sampler. A `pointermove` counts only with a
 *  button held (a drag): a resting or hovering pointer is not interaction. */
const ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "input"];

const KEYBOARD_EVENTS = new Set(["keydown", "keyup", "keypress", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]);

export type InputKind = "keyboard" | "pointer";

export interface PerfSummary {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface PerfSnapshot {
  version: 1;
  /** The window summarized, and how much of it the probe was running for. */
  windowMs: number;
  coveredMs: number;
  supported: { eventTiming: boolean; longTask: boolean; longAnimationFrame: boolean };
  input: {
    /** "event-timing": INP-style latency, `floorMs` meaning "at most 16 ms".
     *  "approximate": input timestamp to the frame after it, no floor. */
    source: "event-timing" | "approximate";
    floorMs: number;
    all: PerfSummary;
    keyboard: PerfSummary;
    pointer: PerfSummary;
  };
  frames: PerfSummary & { histogram: { upToMs: number | null; n: number }[] };
  longTasks: PerfSummary | null;
  longAnimationFrames: PerfSummary | null;
}

export interface PerfProbe {
  snapshot(windowMs?: number): PerfSnapshot;
  /** Forget every sample — the start of a measured scenario. */
  reset(): void;
  stop(): void;
}

declare global {
  interface Window {
    __rlPerf?: PerfProbe;
  }
}

/** The platform the probe reads, injectable so the tests can drive it. */
export interface ProbeEnv {
  now(): number;
  raf(cb: (t: number) => void): number;
  cancelRaf(id: number): void;
  /** Where input is counted (capture phase) — the window. */
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  Observer: typeof PerformanceObserver | undefined;
  /** Where the live probe is published. */
  host: { __rlPerf?: PerfProbe };
}

function browserEnv(): ProbeEnv {
  return {
    now: () => performance.now(),
    raf: (cb) => requestAnimationFrame(cb),
    cancelRaf: (id) => cancelAnimationFrame(id),
    target: window,
    doc: document,
    Observer: typeof PerformanceObserver === "function" ? PerformanceObserver : undefined,
    host: window,
  };
}

/** A fixed-capacity series of (time, value, kind) samples, oldest overwritten. */
class Ring {
  private t: Float64Array;
  private v: Float64Array;
  private k: Uint8Array;
  private head = 0;
  private size = 0;
  constructor(private cap: number) {
    this.t = new Float64Array(cap);
    this.v = new Float64Array(cap);
    this.k = new Uint8Array(cap);
  }
  push(t: number, v: number, k = 0) {
    this.t[this.head] = t;
    this.v[this.head] = v;
    this.k[this.head] = k;
    this.head = (this.head + 1) % this.cap;
    this.size = Math.min(this.size + 1, this.cap);
  }
  /** Values at or after `since`, optionally of one kind, oldest first. */
  since(since: number, kind?: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.size; i++) {
      const j = (this.head - this.size + i + this.cap) % this.cap;
      if (this.t[j] >= since && (kind === undefined || this.k[j] === kind)) out.push(this.v[j]);
    }
    return out;
  }
  clear() {
    this.head = 0;
    this.size = 0;
  }
}

const KIND_CODE: Record<InputKind, number> = { keyboard: 1, pointer: 2 };

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export function summarize(values: readonly number[]): PerfSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    const v = percentile(sorted, q);
    return v === null ? null : round(v);
  };
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

export function frameHistogram(gaps: readonly number[]): { upToMs: number | null; n: number }[] {
  const buckets: { upToMs: number | null; n: number }[] = [
    ...FRAME_BUCKETS_MS.map((upToMs) => ({ upToMs, n: 0 })),
    { upToMs: null, n: 0 },
  ];
  for (const g of gaps) {
    const i = FRAME_BUCKETS_MS.findIndex((ceiling) => g <= ceiling);
    buckets[i === -1 ? buckets.length - 1 : i].n++;
  }
  return buckets;
}

/** Interaction latencies for one kind: the slow ones Event Timing reported,
 *  plus every counted input it didn't, at the floor. */
export function withFloor(slow: readonly number[], counted: number, floorMs: number): number[] {
  return [...slow, ...Array<number>(Math.max(0, counted - slow.length)).fill(floorMs)];
}

function kindOf(eventName: string): InputKind {
  return KEYBOARD_EVENTS.has(eventName) ? "keyboard" : "pointer";
}

/** Start measuring, or return the probe already running. Never throws: an
 *  engine missing any instrument just reports it as unsupported. */
export function startPerfProbe(env: ProbeEnv = browserEnv()): PerfProbe {
  if (env.host.__rlPerf) return env.host.__rlPerf;
  const supported = new Set(env.Observer?.supportedEntryTypes ?? []);
  const eventTiming = supported.has("event");
  let startedAt = env.now();

  const inputs = new Ring(4096); // counted keydown / pointerdown
  const approx = new Ring(4096); // fallback latencies
  const frames = new Ring(16384); // ~2 minutes at 120 Hz
  const longTasks = new Ring(1024);
  const longFrames = new Ring(1024);
  // interactionId → its slowest event. Capped like the rings; a Map iterates
  // in insertion order, so the first key is always the oldest.
  const slow = new Map<number, { t: number; ms: number; kind: number }>();

  const observers: PerformanceObserver[] = [];
  const observe = (type: string, onEntry: (e: PerformanceEntry) => void, extra: object = {}) => {
    if (!env.Observer || !supported.has(type)) return;
    try {
      const o = new env.Observer((list) => list.getEntries().forEach(onEntry));
      o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(o);
    } catch {
      // An engine that lists a type but rejects the options: leave it out.
    }
  };
  observe(
    "event",
    (e) => {
      // `interactionId` postdates this TypeScript's DOM lib; 0 = not part of
      // an interaction (a hover, a scroll).
      const id = (e as PerformanceEntry & { interactionId?: number }).interactionId;
      if (!id) return;
      const prev = slow.get(id);
      if (!prev) {
        slow.set(id, { t: e.startTime, ms: e.duration, kind: KIND_CODE[kindOf(e.name)] });
        if (slow.size > 4096) slow.delete(slow.keys().next().value!);
      } else if (e.duration > prev.ms) prev.ms = e.duration;
    },
    { durationThreshold: EVENT_FLOOR_MS },
  );
  observe("longtask", (e) => longTasks.push(e.startTime, e.duration));
  observe("long-animation-frame", (e) => longFrames.push(e.startTime, e.duration));

  // Count every input (so unreported fast interactions still count), and
  // without Event Timing, time each one to the end of the frame after it.
  const onInput = (ev: Event) => {
    const kind = KIND_CODE[ev.type === "keydown" ? "keyboard" : "pointer"];
    const at = ev.timeStamp || env.now();
    inputs.push(at, 0, kind);
    if (!eventTiming) {
      env.raf(() => setTimeout(() => approx.push(at, env.now() - at, kind), 0));
    }
  };
  const listen = { capture: true, passive: true } as const;
  env.target.addEventListener("keydown", onInput, listen);
  env.target.addEventListener("pointerdown", onInput, listen);

  // Frame gaps while the user interacts with a visible page: input starts
  // the loop, and it stops itself FRAME_TAIL_MS after the last input. The
  // first frame of each run only sets the clock, so the time spent stopped
  // or hidden is dropped rather than read as a stall.
  let rafId: number | null = null;
  let last = 0;
  let lastInput = -Infinity;
  const tick = (t: number) => {
    if (last) frames.push(t, t - last);
    const on = t - lastInput < FRAME_TAIL_MS;
    last = on ? t : 0;
    rafId = on ? env.raf(tick) : null;
  };
  const run = () => {
    if (rafId === null && env.doc.visibilityState === "visible") rafId = env.raf(tick);
  };
  const onActivity = (ev: Event) => {
    if (ev.type === "pointermove" && !(ev as PointerEvent).buttons) return;
    lastInput = env.now();
    run();
  };
  for (const type of ACTIVITY_EVENTS) env.target.addEventListener(type, onActivity, listen);
  const onVisibility = () => {
    if (rafId !== null) env.cancelRaf(rafId);
    rafId = null;
    last = 0;
    if (env.now() - lastInput < FRAME_TAIL_MS) run();
  };
  env.doc.addEventListener("visibilitychange", onVisibility);

  const probe: PerfProbe = {
    snapshot(windowMs = DEFAULT_WINDOW_MS) {
      const now = env.now();
      const span = Math.min(Math.max(windowMs, 1000), RETAIN_MS);
      const since = now - span;
      const inputSummary = (kind?: number) => {
        if (!eventTiming) return summarize(approx.since(since, kind));
        const reported = [...slow.values()]
          .filter((s) => s.t >= since && (kind === undefined || s.kind === kind))
          .map((s) => s.ms);
        return summarize(withFloor(reported, inputs.since(since, kind).length, EVENT_FLOOR_MS));
      };
      const gaps = frames.since(since);
      return {
        version: 1,
        windowMs: span,
        coveredMs: round(Math.min(span, now - startedAt)),
        supported: {
          eventTiming,
          longTask: supported.has("longtask"),
          longAnimationFrame: supported.has("long-animation-frame"),
        },
        input: {
          source: eventTiming ? "event-timing" : "approximate",
          floorMs: eventTiming ? EVENT_FLOOR_MS : 0,
          all: inputSummary(),
          keyboard: inputSummary(KIND_CODE.keyboard),
          pointer: inputSummary(KIND_CODE.pointer),
        },
        frames: { ...summarize(gaps), histogram: frameHistogram(gaps) },
        longTasks: supported.has("longtask") ? summarize(longTasks.since(since)) : null,
        longAnimationFrames: supported.has("long-animation-frame") ? summarize(longFrames.since(since)) : null,
      };
    },
    reset() {
      for (const r of [inputs, approx, frames, longTasks, longFrames]) r.clear();
      slow.clear();
      startedAt = env.now();
    },
    stop() {
      for (const o of observers) o.disconnect();
      env.target.removeEventListener("keydown", onInput, listen);
      env.target.removeEventListener("pointerdown", onInput, listen);
      for (const type of ACTIVITY_EVENTS) env.target.removeEventListener(type, onActivity, listen);
      env.doc.removeEventListener("visibilitychange", onVisibility);
      if (rafId !== null) env.cancelRaf(rafId);
      if (env.host.__rlPerf === probe) delete env.host.__rlPerf;
    },
  };
  env.host.__rlPerf = probe;
  return probe;
}

/** Stop the running probe, if any. */
export function stopPerfProbe(host: { __rlPerf?: PerfProbe } = window): void {
  host.__rlPerf?.stop();
}
