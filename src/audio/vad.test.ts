// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";
import {
  UtteranceDetector,
  DEFAULT_VAD_SILENCE_MS,
  DEFAULT_VAD_CONTINUATION_MS,
  endpointSilenceMs,
  type TimerHandle,
} from "./vad";

/** A controllable clock so the silence-timer logic is deterministic (no real
 *  setTimeout). `advance(ms)` runs every job whose deadline has elapsed. */
function fakeClock() {
  let now = 0;
  let seq = 1;
  let jobs: { id: number; at: number; fn: () => void }[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const id = seq++;
    jobs.push({ id, at: now + ms, fn });
    return id;
  };
  const clearTimer = (h: TimerHandle) => {
    jobs = jobs.filter((j) => j.id !== (h as number));
  };
  const advance = (ms: number) => {
    now += ms;
    const due = jobs.filter((j) => j.at <= now).sort((a, b) => a.at - b.at);
    for (const j of due) {
      jobs = jobs.filter((x) => x !== j);
      j.fn();
    }
  };
  return { setTimer, clearTimer, advance };
}

function detector(onEnd: (t: string) => void, silenceMs = 1000) {
  const clock = fakeClock();
  const d = new UtteranceDetector({
    silenceMs,
    onUtteranceEnd: onEnd,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { d, clock };
}

describe("UtteranceDetector", () => {
  it("ends the utterance after a silent pause, with the latest transcript", () => {
    const onEnd = vi.fn();
    const { d, clock } = detector(onEnd);
    d.feed("hello");
    d.feed("hello there");
    d.feed("hello there friend");
    clock.advance(999); // still within the pause window
    expect(onEnd).not.toHaveBeenCalled();
    clock.advance(1); // pause elapses
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("hello there friend");
  });

  it("keeps pushing the deadline out while speech is still growing", () => {
    const onEnd = vi.fn();
    const { d, clock } = detector(onEnd);
    d.feed("one");
    clock.advance(800);
    d.feed("one two"); // new speech before the pause → re-arm
    clock.advance(800);
    expect(onEnd).not.toHaveBeenCalled(); // 1600ms total, but never 1000ms quiet
    clock.advance(200);
    expect(onEnd).toHaveBeenCalledWith("one two");
  });

  it("ignores empty / blank partials so pre-speech silence never fires", () => {
    const onEnd = vi.fn();
    const { d, clock } = detector(onEnd);
    d.feed("");
    d.feed("   ");
    clock.advance(5000);
    expect(onEnd).not.toHaveBeenCalled();
    expect(d.pending).toBe(false);
  });

  it("does not re-arm on an unchanged partial (silence still elapses)", () => {
    const onEnd = vi.fn();
    const { d, clock } = detector(onEnd);
    d.feed("steady");
    clock.advance(500);
    d.feed("steady"); // identical → must NOT reset the timer
    clock.advance(500);
    expect(onEnd).toHaveBeenCalledWith("steady");
  });

  it("reset cancels a pending utterance", () => {
    const onEnd = vi.fn();
    const { d, clock } = detector(onEnd);
    d.feed("about to be cancelled");
    expect(d.pending).toBe(true);
    d.reset();
    expect(d.pending).toBe(false);
    clock.advance(5000);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("fires once per utterance, then starts a fresh one on new speech", () => {
    const onEnd = vi.fn();
    const { d, clock } = detector(onEnd);
    d.feed("first utterance");
    clock.advance(1000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    clock.advance(5000); // no new speech → no extra fires
    expect(onEnd).toHaveBeenCalledTimes(1);
    d.feed("second utterance");
    clock.advance(1000);
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenLastCalledWith("second utterance");
  });

  it("defaults to the shared silence constant when none is given", () => {
    const onEnd = vi.fn();
    const clock = fakeClock();
    const d = new UtteranceDetector({
      onUtteranceEnd: onEnd,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    d.feed("hi");
    clock.advance(DEFAULT_VAD_SILENCE_MS - 1);
    expect(onEnd).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("waits the longer window when the transcript ends mid-thought", () => {
    const onEnd = vi.fn();
    const clock = fakeClock();
    const d = new UtteranceDetector({
      silenceMs: 1000,
      continuationMs: 3000,
      onUtteranceEnd: onEnd,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    // Ends on a dangling conjunction → not done yet.
    d.feed("change the timeout and");
    clock.advance(1000); // the base window would have fired here — must not
    expect(onEnd).not.toHaveBeenCalled();
    // The speaker continues; now it sounds finished → base window applies.
    d.feed("change the timeout and make it configurable");
    clock.advance(1000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("change the timeout and make it configurable");
  });

  it("does not fire on a brief pause after a trailing article/preposition", () => {
    const onEnd = vi.fn();
    const clock = fakeClock();
    const d = new UtteranceDetector({
      silenceMs: 1000,
      continuationMs: 3000,
      onUtteranceEnd: onEnd,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    d.feed("rename the section to"); // ends on "to"
    clock.advance(2999);
    expect(onEnd).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onEnd).toHaveBeenCalledWith("rename the section to");
  });
});

describe("endpointSilenceMs", () => {
  const base = 1000;
  const cont = 3000;
  it("uses the base window for a finished-sounding utterance", () => {
    expect(endpointSilenceMs("make the timeout configurable", base, cont)).toBe(base);
    expect(endpointSilenceMs("do that.", base, cont)).toBe(base);
    expect(endpointSilenceMs("are you sure?", base, cont)).toBe(base);
    expect(endpointSilenceMs('say "hello"', base, cont)).toBe(base); // content word under quotes
  });
  it("uses the longer window when it ends mid-thought", () => {
    expect(endpointSilenceMs("change the timeout and", base, cont)).toBe(cont);
    expect(endpointSilenceMs("rename the section to", base, cont)).toBe(cont);
    expect(endpointSilenceMs("first, ", base, cont)).toBe(cont); // trailing comma
    expect(endpointSilenceMs("I want the", base, cont)).toBe(cont); // trailing article
    expect(endpointSilenceMs("um", base, cont)).toBe(cont); // filler
  });
  it("default continuation constant is longer than the base", () => {
    expect(DEFAULT_VAD_CONTINUATION_MS).toBeGreaterThan(DEFAULT_VAD_SILENCE_MS);
  });
});
