// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTerminalSwapForTest,
  beginTerminalSwap,
  cancelTerminalWork,
  deferTerminalWork,
  pendingTerminalWork,
  TERMINAL_WORK_BUDGET_MS,
  terminalSwapSettling,
} from "./terminalSwap";

// A hand-cranked frame clock: `tick()` runs the callbacks queued for the
// next frame, and `clock` is what performance.now() reads.
let frames: FrameRequestCallback[] = [];
let clock = 0;
function tick(): void {
  const due = frames;
  frames = [];
  for (const cb of due) cb(clock);
}
beforeEach(() => {
  frames = [];
  clock = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = () => {}; });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  __resetTerminalSwapForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("deferred terminal work", () => {
  it("runs on a later frame, never in the call that queued it", () => {
    const task = vi.fn();
    deferTerminalWork("show:a", task);
    expect(task).not.toHaveBeenCalled();
    tick();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("keeps one task per key: a tile fits once however many resizes it saw", () => {
    const first = vi.fn();
    const last = vi.fn();
    deferTerminalWork("fit:a", first);
    deferTerminalWork("fit:a", first);
    deferTerminalWork("fit:a", last);
    tick();
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledTimes(1);
  });

  it("drops a cancelled task", () => {
    const task = vi.fn();
    deferTerminalWork("show:a", task);
    cancelTerminalWork("show:a");
    tick();
    expect(task).not.toHaveBeenCalled();
    expect(pendingTerminalWork()).toBe(0);
  });

  it("staggers expensive work one task a frame, and batches cheap work into one", () => {
    const ran: string[] = [];
    for (const id of ["a", "b", "c"]) {
      deferTerminalWork(`show:${id}`, () => { ran.push(id); clock += TERMINAL_WORK_BUDGET_MS * 8; });
    }
    tick();
    expect(ran).toEqual(["a"]);
    tick();
    expect(ran).toEqual(["a", "b"]);
    tick();
    expect(ran).toEqual(["a", "b", "c"]);
    const cheap: string[] = [];
    for (const id of ["d", "e", "f", "g"]) deferTerminalWork(`show:${id}`, () => { cheap.push(id); clock += 1; });
    tick();
    expect(cheap).toEqual(["d", "e", "f", "g"]);
  });

  it("holds everything while a swap settles, and starts on the frame after the swap painted", () => {
    const painted = vi.fn();
    beginTerminalSwap(painted);
    expect(terminalSwapSettling()).toBe(true);
    const fit = vi.fn();
    deferTerminalWork("fit:a", fit);
    tick(); // the swap's own frame
    expect(fit).not.toHaveBeenCalled();
    expect(painted).not.toHaveBeenCalled();
    tick(); // that frame has painted
    expect(painted).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(terminalSwapSettling()).toBe(false);
  });

  it("a second swap before the first paints supersedes it", () => {
    const first = vi.fn();
    const second = vi.fn();
    beginTerminalSwap(first);
    tick();
    beginTerminalSwap(second);
    tick();
    tick();
    tick();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a failing task never stops the rest", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    deferTerminalWork("show:a", () => { throw new Error("boom"); });
    deferTerminalWork("show:b", after);
    tick();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
