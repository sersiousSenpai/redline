// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { RELEASE_EVENT, watchRelease } from "./pressRelease";

// LAST2 walk: drops and seam drags waited for an extra click when their
// release went somewhere this document never hears.
describe("watchRelease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("ends on a pointerup or a mouseup heard in the capture phase, once, with its point", () => {
    const done = vi.fn();
    watchRelease(done);
    const keeper = document.createElement("div");
    keeper.addEventListener("pointerup", (e) => e.stopPropagation());
    document.body.append(keeper);
    keeper.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 5, clientY: 6 }));
    keeper.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith({ x: 5, y: 6 });
    keeper.remove();
  });

  it("reads a mouse move with the button up, or a release a page heard, as the release", () => {
    const moved = vi.fn();
    watchRelease(moved);
    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 1 }));
    expect(moved).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0, clientX: 9, clientY: 9 }));
    expect(moved).toHaveBeenCalledWith({ x: 9, y: 9 });
    const heard = vi.fn();
    watchRelease(heard);
    window.dispatchEvent(new Event(RELEASE_EVENT));
    expect(heard).toHaveBeenCalledWith(null);
  });

  it("in the app, asks the window server: the button up ends the press with no event at all", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(true);
    const done = vi.fn();
    const stop = watchRelease(done);
    await vi.advanceTimersByTimeAsync(250);
    expect(invoke).toHaveBeenCalledWith("pointer_pressed");
    expect(done).not.toHaveBeenCalled();
    invoke.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(120);
    expect(done).toHaveBeenCalledWith(null);
    // Ended: it asks no more.
    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).not.toHaveBeenCalled();
    stop();
  });

  it("stop() ends the watch without a release", () => {
    const done = vi.fn();
    watchRelease(done)();
    window.dispatchEvent(new MouseEvent("pointerup", { button: 0 }));
    expect(done).not.toHaveBeenCalled();
  });
});
