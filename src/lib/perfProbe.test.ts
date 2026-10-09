// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_FLOOR_MS,
  frameHistogram,
  percentile,
  startPerfProbe,
  stopPerfProbe,
  summarize,
  withFloor,
  type PerfProbe,
  type ProbeEnv,
} from "./perfProbe";
import { PERF_PROBE_KEY, perfProbeWanted } from "./perfProbeSwitch";

/** A scripted platform: a clock, a frame pump, an Event Timing feed. */
function fakeEnv(entryTypes: string[] = ["event"]) {
  let clock = 0;
  let frameCb: ((t: number) => void) | null = null;
  const observers: { type: string; cb: PerformanceObserverCallback; opts: PerformanceObserverInit }[] = [];
  class Observer {
    static supportedEntryTypes = entryTypes;
    constructor(private cb: PerformanceObserverCallback) {}
    observe(opts: PerformanceObserverInit) {
      observers.push({ type: opts.type!, cb: this.cb, opts });
    }
    disconnect() {
      const i = observers.findIndex((o) => o.cb === this.cb);
      if (i >= 0) observers.splice(i, 1);
    }
  }
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const host: { __rlPerf?: PerfProbe } = {};
  const target = new EventTarget();
  const env: ProbeEnv = {
    now: () => clock,
    raf: (cb) => {
      frameCb = cb;
      return 1;
    },
    cancelRaf: () => {
      frameCb = null;
    },
    target,
    doc,
    Observer: Observer as unknown as typeof PerformanceObserver,
    host,
  };
  return {
    env,
    host,
    observers,
    advance(ms: number) {
      clock += ms;
    },
    /** Run frames `gap` ms apart. */
    frames(...gaps: number[]) {
      for (const gap of gaps) {
        clock += gap;
        frameCb?.(clock);
      }
    },
    input(type: "keydown" | "pointerdown") {
      const ev = new Event(type);
      Object.defineProperty(ev, "timeStamp", { value: clock });
      target.dispatchEvent(ev);
    },
    /** Event Timing reporting one event of an interaction. */
    timing(name: string, interactionId: number, duration: number, startTime = clock) {
      const entry = { name, interactionId, duration, startTime, entryType: "event" };
      for (const o of observers.filter((o) => o.type === "event")) {
        o.cb({ getEntries: () => [entry] } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver);
      }
    },
    hide() {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    show() {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("perf probe statistics", () => {
  it("takes nearest-rank percentiles", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(95);
    expect(percentile(sorted, 1)).toBe(100);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("summarizes unsorted samples, and an empty window as nulls", () => {
    expect(summarize([30, 10, 20.04])).toEqual({ n: 3, p50: 20, p95: 30, max: 30 });
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null, max: null });
  });

  it("buckets frame gaps by refresh interval", () => {
    const h = frameHistogram([8, 16.7, 17, 33, 48, 90, 200, 900]);
    expect(h.map((b) => [b.upToMs, b.n])).toEqual([
      [9, 1],
      [17.5, 2],
      [34, 1],
      [50, 1],
      [100, 1],
      [250, 1],
      [null, 1],
    ]);
  });

  it("fills interactions Event Timing never reported at the floor", () => {
    expect(withFloor([120], 4, 16)).toEqual([120, 16, 16, 16]);
    // More reports than counted inputs (an input before the probe started).
    expect(withFloor([40, 50], 1, 16)).toEqual([40, 50]);
  });
});

describe("perf probe", () => {
  it("publishes itself once and observes events past the 16 ms floor", () => {
    const f = fakeEnv(["event", "longtask"]);
    const probe = startPerfProbe(f.env);
    expect(f.host.__rlPerf).toBe(probe);
    expect(startPerfProbe(f.env)).toBe(probe);
    const event = f.observers.find((o) => o.type === "event")!;
    expect(event.opts).toMatchObject({ buffered: true, durationThreshold: EVENT_FLOOR_MS });
    expect(f.observers.map((o) => o.type).sort()).toEqual(["event", "longtask"]);
  });

  it("reports INP-style latency per kind, counting fast interactions at the floor", () => {
    const f = fakeEnv();
    const probe = startPerfProbe(f.env);
    f.advance(1000);
    for (let i = 0; i < 18; i++) f.input("keydown"); // 18 keystrokes…
    f.timing("keydown", 1, 80); // …one slow (its keyup is slower still)
    f.timing("keyup", 1, 96);
    f.timing("keydown", 2, 24);
    f.input("pointerdown");
    f.timing("pointerdown", 3, 210);
    f.timing("pointerup", 3, 40);
    const snap = probe.snapshot();
    expect(snap.input.source).toBe("event-timing");
    expect(snap.input.floorMs).toBe(16);
    expect(snap.input.keyboard).toEqual({ n: 18, p50: 16, p95: 96, max: 96 });
    expect(snap.input.pointer).toEqual({ n: 1, p50: 210, p95: 210, max: 210 });
    expect(snap.input.all.n).toBe(19);
    // Non-interaction events (a hover, a scroll) carry interactionId 0.
    f.timing("pointerover", 0, 300);
    expect(probe.snapshot().input.all.max).toBe(210);
  });

  it("summarizes only the window asked for", () => {
    const f = fakeEnv();
    const probe = startPerfProbe(f.env);
    f.input("keydown");
    f.timing("keydown", 1, 400);
    f.advance(30_000);
    f.input("keydown");
    f.timing("keydown", 2, 32);
    expect(probe.snapshot(10_000).input.keyboard).toEqual({ n: 1, p50: 32, p95: 32, max: 32 });
    expect(probe.snapshot(60_000).input.keyboard.max).toBe(400);
    // The window clamps: never under a second, never past what is retained.
    expect(probe.snapshot(1).windowMs).toBe(1000);
    expect(probe.snapshot(10_000_000).windowMs).toBe(120_000);
    expect(probe.snapshot(10_000).coveredMs).toBe(10_000);
    expect(probe.snapshot(60_000).coveredMs).toBe(30_000);
  });

  it("measures frame gaps while visible and drops the gap across a hide", () => {
    const f = fakeEnv();
    const probe = startPerfProbe(f.env);
    f.frames(16.7, 16.7, 16.7, 120, 16.7);
    let frames = probe.snapshot().frames;
    // The first frame only sets the clock; four gaps follow it.
    expect(frames.n).toBe(4);
    expect(frames.max).toBe(120);
    expect(frames.histogram.find((b) => b.upToMs === 250)!.n).toBe(1);
    f.hide();
    f.advance(5000);
    f.frames(16.7); // nothing runs while hidden
    f.show();
    f.frames(16.7, 16.7);
    frames = probe.snapshot().frames;
    expect(frames.n).toBe(5);
    expect(frames.max).toBe(120);
  });

  it("falls back to an approximate input-to-next-frame time without Event Timing", () => {
    vi.useFakeTimers();
    const f = fakeEnv([]);
    const probe = startPerfProbe(f.env);
    f.input("keydown");
    f.frames(40); // the frame after the keystroke lands 40 ms later
    vi.runAllTimers();
    const snap = probe.snapshot();
    expect(snap.supported).toEqual({ eventTiming: false, longTask: false, longAnimationFrame: false });
    expect(snap.input.source).toBe("approximate");
    expect(snap.input.floorMs).toBe(0);
    expect(snap.input.keyboard).toEqual({ n: 1, p50: 40, p95: 40, max: 40 });
    // An absent instrument reads as absent, never as a clean zero.
    expect(snap.longTasks).toBeNull();
    expect(snap.longAnimationFrames).toBeNull();
  });

  it("reset starts a scenario clean; stop unpublishes and unhooks", () => {
    const f = fakeEnv();
    const probe = startPerfProbe(f.env);
    f.input("keydown");
    f.timing("keydown", 1, 64);
    f.frames(16, 16, 16);
    probe.reset();
    expect(probe.snapshot().input.all.n).toBe(0);
    expect(probe.snapshot().frames.n).toBe(0);
    stopPerfProbe(f.host);
    expect(f.host.__rlPerf).toBeUndefined();
    expect(f.observers).toEqual([]);
    f.input("keydown");
    f.frames(16, 16);
    expect(probe.snapshot().input.all.n).toBe(0);
    expect(probe.snapshot().frames.n).toBe(0);
  });

  it("bounds every series however long it runs", () => {
    const f = fakeEnv();
    const probe = startPerfProbe(f.env);
    for (let i = 0; i < 20_000; i++) f.frames(1);
    // 20,000 frames inside the window, but the ring keeps the newest 16,384.
    expect(probe.snapshot(120_000).frames.n).toBe(16_384);
  });
});

describe("perf probe switch", () => {
  it("is on in dev and off in release unless the stored choice says otherwise", () => {
    expect(perfProbeWanted(null, true)).toBe(true);
    expect(perfProbeWanted(null, false)).toBe(false);
    expect(perfProbeWanted("on", false)).toBe(true);
    expect(perfProbeWanted("off", true)).toBe(false);
    expect(PERF_PROBE_KEY).toBe("redline.perfProbe");
  });
});
