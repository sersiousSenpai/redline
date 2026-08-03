// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rafCoalesce } from "./raf";

// Hand-driven frames: every rAF callback queues here and runs only when the
// test says so, which is the whole point — we're asserting *when* work runs.
let frames: FrameRequestCallback[] = [];
let nextId = 1;

beforeEach(() => {
  frames = [];
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.push(fn);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const runFrame = () => {
  const queued = frames;
  frames = [];
  for (const fn of queued) fn(performance.now());
};

describe("rafCoalesce", () => {
  it("collapses many calls in one frame into a single call with the latest args", () => {
    const spy = vi.fn();
    const coalesced = rafCoalesce(spy);

    coalesced(1);
    coalesced(2);
    coalesced(3);
    expect(spy).not.toHaveBeenCalled();

    runFrame();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(3);
  });

  it("schedules again for the next frame after flushing", () => {
    const spy = vi.fn();
    const coalesced = rafCoalesce(spy);

    coalesced("a");
    runFrame();
    coalesced("b");
    runFrame();

    expect(spy.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("passes every argument through, not just the first", () => {
    const spy = vi.fn();
    const coalesced = rafCoalesce(spy);
    coalesced(1, "x", true);
    runFrame();
    expect(spy).toHaveBeenCalledWith(1, "x", true);
  });

  it("cancel() drops the pending frame", () => {
    const spy = vi.fn();
    const coalesced = rafCoalesce(spy);

    coalesced(1);
    coalesced.cancel();
    runFrame();
    expect(spy).not.toHaveBeenCalled();
  });

  it("flush() runs the pending frame now, and is a no-op when idle", () => {
    const spy = vi.fn();
    const coalesced = rafCoalesce(spy);

    coalesced.flush();
    expect(spy).not.toHaveBeenCalled();

    coalesced(7);
    coalesced.flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(7);

    // The flushed frame must not run a second time.
    runFrame();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
