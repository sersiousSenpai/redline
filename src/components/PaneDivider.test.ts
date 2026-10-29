// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useResizablePane } from "../hooks/useResizablePane";
import { DIVIDER_W } from "../lib/paneLayout";
import { __resetResizeSession, isResizing } from "../lib/resizeSession";
import { PaneDivider, SEAM_GRAB_OVERHANG } from "./PaneDivider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function renderDivider(
  props: Partial<Parameters<typeof PaneDivider>[0]> = {},
): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  act(() => {
    r.render(
      createElement(PaneDivider, {
        collapsed: false,
        dragging: false,
        onPointerDown: () => {},
        ...props,
      }),
    );
  });
  return host;
}

// D38: the seam between two columns is one 1px rule that is also the drag
// handle — no gutter, and no chevron pill in any state.
describe("PaneDivider — the seam (D38)", () => {
  it("is one rule wide and draws no button, expanded, folded or fullscreen", () => {
    for (const props of [{}, { collapsed: true }, { fullscreen: true }, { side: "leading" as const, label: "sidebar" }]) {
      const host = renderDivider(props);
      const seam = host.querySelector<HTMLElement>(".rl-divider")!;
      expect(seam.style.width).toBe(`${DIVIDER_W}px`);
      expect(DIVIDER_W).toBe(1);
      expect(host.querySelector("button")).toBeNull();
      host.remove();
    }
  });

  it("grabs past the rule on both sides without taking layout width", () => {
    const host = renderDivider();
    const grab = host.querySelector<HTMLElement>(".rl-divider-grab")!;
    expect(grab.style.left).toBe(`${-SEAM_GRAB_OVERHANG}px`);
    expect(grab.style.right).toBe(`${-SEAM_GRAB_OVERHANG}px`);
    expect(grab.title).toBe("Drag to resize the rail");
    host.remove();
  });

  it("a folded column's seam says the drag opens it; a fullscreen one is not a handle", () => {
    const folded = renderDivider({ collapsed: true, label: "sidebar" });
    expect(folded.querySelector<HTMLElement>(".rl-divider-grab")!.title).toBe("Drag to show the sidebar");
    folded.remove();
    const full = renderDivider({ fullscreen: true });
    expect(full.querySelector<HTMLElement>(".rl-divider-grab")!.style.cursor).toBe("default");
    full.remove();
  });
});

// ── Drag harness ──────────────────────────────────────────────────────────
//
// The contract that makes a drag frame cheap: while a live path is supplied,
// `onLiveSize` fires at most once per animation frame and `onWidthChange` — the
// one that becomes React state, persists to localStorage and re-renders the
// world — fires exactly once, on release.

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
    onPointerDown: startDrag,
  });
}

function mount(onLive: (n: number) => void, onRest: (n: number) => void) {
  act(() => {
    root.render(createElement(Harness, { onLive, onRest }));
  });
  const grab = container.querySelector<HTMLElement>(
    '[title="Drag to resize the rail"]',
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
