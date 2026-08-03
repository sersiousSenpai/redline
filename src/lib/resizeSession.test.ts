// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetResizeSession,
  beginResizeSession,
  endResizeSession,
  installWindowResizeSession,
  isResizing,
  onResizeSession,
} from "./resizeSession";

const flag = () => document.documentElement.getAttribute("data-rl-resizing");

beforeEach(() => {
  __resetResizeSession();
});
afterEach(() => {
  __resetResizeSession();
  vi.useRealTimers();
});

describe("resize session refcount", () => {
  it("sets the DOM flag on the first begin and clears it on the last end", () => {
    expect(isResizing()).toBe(false);
    expect(flag()).toBe(null);

    beginResizeSession();
    expect(isResizing()).toBe(true);
    expect(flag()).toBe("1");

    endResizeSession();
    expect(isResizing()).toBe(false);
    expect(flag()).toBe(null);
  });

  it("stays active while any source is still resizing", () => {
    beginResizeSession();
    beginResizeSession();
    endResizeSession();
    // The window adapter released, but the pointer drag has not.
    expect(isResizing()).toBe(true);
    expect(flag()).toBe("1");
    endResizeSession();
    expect(isResizing()).toBe(false);
  });

  it("ignores an unbalanced end rather than going negative", () => {
    endResizeSession();
    endResizeSession();
    expect(isResizing()).toBe(false);
    // A later real session must still work — a negative count would have
    // needed two begins to get back to active.
    beginResizeSession();
    expect(isResizing()).toBe(true);
  });

  it("notifies subscribers only on the outermost transitions", () => {
    const seen: boolean[] = [];
    const off = onResizeSession((active) => seen.push(active));

    beginResizeSession();
    beginResizeSession();
    endResizeSession();
    endResizeSession();
    expect(seen).toEqual([true, false]);

    off();
    beginResizeSession();
    endResizeSession();
    expect(seen).toEqual([true, false]);
  });

  it("fans out to every subscriber, and one thrower cannot strand the rest", () => {
    const seen: string[] = [];
    onResizeSession(() => {
      throw new Error("boom");
    });
    onResizeSession((active) => seen.push(active ? "on" : "off"));

    beginResizeSession();
    endResizeSession();
    expect(seen).toEqual(["on", "off"]);
    expect(isResizing()).toBe(false);
  });
});

describe("installWindowResizeSession", () => {
  it("opens once for a burst of resize events and closes on the settle timer", () => {
    vi.useFakeTimers();
    const uninstall = installWindowResizeSession(150);

    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    expect(isResizing()).toBe(true);

    // Each event restarts the settle window.
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(100);
    expect(isResizing()).toBe(true);

    vi.advanceTimersByTime(50);
    expect(isResizing()).toBe(false);
    expect(flag()).toBe(null);

    uninstall();
  });

  it("never unbalances a pointer drag that overlaps a window resize", () => {
    vi.useFakeTimers();
    const uninstall = installWindowResizeSession(150);

    // A divider drag starts…
    beginResizeSession();
    // …and the OS window is resized underneath it.
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(150);
    // The window settled, but the drag is still live.
    expect(isResizing()).toBe(true);

    endResizeSession();
    expect(isResizing()).toBe(false);

    uninstall();
  });

  it("closes an open session when uninstalled mid-resize", () => {
    vi.useFakeTimers();
    const uninstall = installWindowResizeSession(150);
    window.dispatchEvent(new Event("resize"));
    expect(isResizing()).toBe(true);

    uninstall();
    expect(isResizing()).toBe(false);

    // And the listener is really gone.
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
    expect(isResizing()).toBe(false);
  });
});
