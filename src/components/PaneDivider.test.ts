// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useResizablePane } from "../hooks/useResizablePane";
import { __resetResizeSession, isResizing } from "../lib/resizeSession";
import { collapsedCaretNudge, PaneDivider } from "./PaneDivider";

describe("collapsedCaretNudge", () => {
  it("leaves an expanded divider's caret centred", () => {
    expect(collapsedCaretNudge(false, "vertical", "leading")).toBe(0);
    expect(collapsedCaretNudge(false, "vertical", "trailing")).toBe(0);
  });

  it("shifts a collapsed leading pane's caret inward (rightward)", () => {
    // Sidebar collapsed: its divider hugs the row's left edge, so the pill
    // must move right to clear the clip. (18px pill on the 10px gutter →
    // 4px overhang per side.)
    expect(collapsedCaretNudge(true, "vertical", "leading")).toBe(4);
  });

  it("shifts a collapsed trailing pane's caret inward (leftward)", () => {
    // Discussion pane collapsed: its divider hugs the row's right edge.
    expect(collapsedCaretNudge(true, "vertical", "trailing")).toBe(-4);
  });

  it("mirrors the two sides exactly, so both carets look identical", () => {
    expect(collapsedCaretNudge(true, "vertical", "leading")).toBe(
      -collapsedCaretNudge(true, "vertical", "trailing"),
    );
  });

  it("leaves horizontal dividers alone in both states", () => {
    // The bottom dock's divider spans the full width; it never hugs a side
    // edge, so nudging it would just decentre the caret.
    expect(collapsedCaretNudge(true, "horizontal", "trailing")).toBe(0);
    expect(collapsedCaretNudge(false, "horizontal", "leading")).toBe(0);
  });

  it("tracks the divider's overhang when it is not the default", () => {
    expect(collapsedCaretNudge(true, "vertical", "leading", 10)).toBe(10);
    expect(collapsedCaretNudge(true, "vertical", "trailing", 10)).toBe(-10);
  });
});

// ── Drag harness ──────────────────────────────────────────────────────────
//
// The contract that makes a drag frame cheap: while a live path is supplied,
// `onLiveSize` fires at most once per animation frame and `onWidthChange` — the
// one that becomes React state, persists to localStorage and re-renders the
// world — fires exactly once, on release.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let frames: FrameRequestCallback[] = [];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  __resetResizeSession();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  __resetResizeSession();
});

const runFrame = () =>
  act(() => {
    const queued = frames;
    frames = [];
    for (const fn of queued) fn(0);
  });

/** jsdom has no PointerEvent; the handlers only read MouseEvent fields. */
const pointer = (type: string, clientX: number) =>
  new MouseEvent(type, { bubbles: true, clientX, clientY: 0 });

function Harness(props: {
  onLive: (n: number) => void;
  onRest: (n: number) => void;
}) {
  const [width, setWidth] = useState(320);
  const { startDrag } = useResizablePane({
    width,
    onWidthChange: (n) => {
      props.onRest(n);
      setWidth(n);
    },
    onLiveSize: props.onLive,
    min: 240,
    max: 900,
  });
  return createElement(PaneDivider, {
    collapsed: false,
    dragging: false,
    onToggle: () => {},
    onPointerDown: startDrag,
  });
}

function mount(onLive: (n: number) => void, onRest: (n: number) => void) {
  act(() => {
    root.render(createElement(Harness, { onLive, onRest }));
  });
  const grab = container.querySelector<HTMLElement>(
    '[title="Drag to resize comments"]',
  );
  if (!grab) throw new Error("grab zone not found");
  return grab;
}

describe("useResizablePane live drag", () => {
  it("fires onLiveSize per frame and onWidthChange once, on release", () => {
    const onLive = vi.fn();
    const onRest = vi.fn();
    const grab = mount(onLive, onRest);

    act(() => {
      grab.dispatchEvent(pointer("pointerdown", 500));
    });
    expect(isResizing()).toBe(true);
    expect(onRest).not.toHaveBeenCalled();

    // Two moves inside one frame collapse to a single live call with the
    // freshest width. Trailing pane: it grows as the pointer moves left.
    act(() => {
      window.dispatchEvent(pointer("pointermove", 480));
      window.dispatchEvent(pointer("pointermove", 460));
    });
    expect(onLive).not.toHaveBeenCalled();
    runFrame();
    expect(onLive.mock.calls).toEqual([[360]]);
    expect(onRest).not.toHaveBeenCalled();

    // A second frame commits again — live, still no state.
    act(() => window.dispatchEvent(pointer("pointermove", 440)));
    runFrame();
    expect(onLive.mock.calls).toEqual([[360], [380]]);
    expect(onRest).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(pointer("pointerup", 440)));
    expect(onRest.mock.calls).toEqual([[380]]);
    expect(isResizing()).toBe(false);
  });

  it("commits the freshest width even when the release beats the frame", () => {
    const onLive = vi.fn();
    const onRest = vi.fn();
    const grab = mount(onLive, onRest);

    act(() => grab.dispatchEvent(pointer("pointerdown", 500)));
    act(() => window.dispatchEvent(pointer("pointermove", 420)));
    // No frame ran, so nothing was ever handed to the live path…
    expect(onLive).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(pointer("pointerup", 420)));
    // …and the rest value is still exact.
    expect(onRest.mock.calls).toEqual([[400]]);
  });

  it("commits the starting width for a press with no movement", () => {
    const onLive = vi.fn();
    const onRest = vi.fn();
    const grab = mount(onLive, onRest);

    act(() => grab.dispatchEvent(pointer("pointerdown", 500)));
    act(() => window.dispatchEvent(pointer("pointerup", 500)));
    expect(onLive).not.toHaveBeenCalled();
    expect(onRest.mock.calls).toEqual([[320]]);
    expect(isResizing()).toBe(false);
  });

  it("clamps to min/max and releases the session on every exit", () => {
    const onLive = vi.fn();
    const onRest = vi.fn();
    const grab = mount(onLive, onRest);

    act(() => grab.dispatchEvent(pointer("pointerdown", 500)));
    // Far past the max (500 - x + 320 > 900 ⇒ x < -80).
    act(() => window.dispatchEvent(pointer("pointermove", -500)));
    runFrame();
    expect(onLive.mock.calls).toEqual([[900]]);
    // Far past the min, with no onCollapse supplied: it clamps rather than snaps.
    act(() => window.dispatchEvent(pointer("pointermove", 5000)));
    runFrame();
    const calls = onLive.mock.calls;
    expect(calls[calls.length - 1]).toEqual([240]);

    act(() => window.dispatchEvent(pointer("pointerup", 5000)));
    expect(isResizing()).toBe(false);
  });
});
