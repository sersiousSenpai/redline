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

// ── The terminal divider's two extra modes ───────────────────────────────
//
// Dock fullscreen used to be reachable only from a `⤢` inside the focused
// tile's header. These two props move it to the divider — the dock's own edge,
// and the caret users already reach for — and give collapse a pill of its own,
// because the drag has a 120px floor and can never close the dock.

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
        orientation: "horizontal",
        label: "terminal",
        collapsed: false,
        dragging: false,
        onToggle: () => {},
        onPointerDown: () => {},
        ...props,
      }),
    );
  });
  return host;
}

const centrePill = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>(
    "button[aria-label='Fullscreen terminal'], button[aria-label='Collapse terminal'], button[aria-label='Show terminal'], button[aria-label='Exit fullscreen terminal']",
  );

describe("PaneDivider — toggleMode / actionVisible", () => {
  it("toggleMode='fullscreen' turns the expanded centre pill into ⤢", () => {
    const host = renderDivider({ toggleMode: "fullscreen" });
    const pill = host.querySelector<HTMLButtonElement>(
      "button[aria-label='Fullscreen terminal']",
    );
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("⤢");
    // The diagonal glyph is already directional; rotating it would point it
    // at the wrong corner.
    expect(host.querySelector("span[style*='rotate']")).toBeNull();
  });

  it("...and calls onToggle, exactly as the collapse pill did", () => {
    const onToggle = vi.fn();
    const host = renderDivider({ toggleMode: "fullscreen", onToggle });
    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          "button[aria-label='Fullscreen terminal']",
        )!
        .click();
    });
    expect(onToggle).toHaveBeenCalled();
  });

  it("a COLLAPSED divider still shows the plain re-open caret", () => {
    // Collapsed, the pane isn't there to make fullscreen; the gesture still
    // means "show me the terminal".
    const host = renderDivider({ toggleMode: "fullscreen", collapsed: true });
    expect(
      host.querySelector("button[aria-label='Show terminal']"),
    ).not.toBeNull();
    expect(host.textContent).not.toContain("⤢");
  });

  it("a FULLSCREEN divider mirrors the glyph to ⤡", () => {
    const host = renderDivider({
      toggleMode: "fullscreen",
      fullscreen: true,
      onExitFullscreen: () => {},
    });
    const pill = centrePill(host);
    expect(pill!.textContent).toContain("⤡");
    expect(pill!.getAttribute("aria-label")).toBe("Exit fullscreen terminal");
  });

  it("the default toggleMode is untouched — every other divider keeps its caret", () => {
    const host = renderDivider();
    expect(host.textContent).not.toContain("⤢");
    expect(
      host.querySelector("button[aria-label='Collapse terminal']"),
    ).not.toBeNull();
  });

  it("actionVisible='expanded' shows the action pill while expanded", () => {
    const onClick = vi.fn();
    const action = { glyph: "⌄", label: "Collapse terminal", onClick };
    const expanded = renderDivider({
      toggleMode: "fullscreen",
      actionVisible: "expanded",
      action,
    });
    const pill = expanded.querySelector<HTMLButtonElement>(
      "button[aria-label='Collapse terminal']",
    );
    expect(pill).not.toBeNull();
    act(() => pill!.click());
    expect(onClick).toHaveBeenCalled();

    // ...and hides it once collapsed, where the centre caret already reopens.
    const collapsed = renderDivider({
      toggleMode: "fullscreen",
      actionVisible: "expanded",
      action,
      collapsed: true,
    });
    expect(
      collapsed.querySelector("button[aria-label='Collapse terminal']"),
    ).toBeNull();
  });

  it("the default actionVisible still hides the action while expanded", () => {
    // The sidebar's "Plan a build": collapsed-only, because expanded its own
    // row is right there.
    const action = { glyph: "＋", label: "Plan a build", onClick: () => {} };
    expect(
      renderDivider({ action }).querySelector(
        "button[aria-label='Plan a build']",
      ),
    ).toBeNull();
    expect(
      renderDivider({ action, collapsed: true }).querySelector(
        "button[aria-label='Plan a build']",
      ),
    ).not.toBeNull();
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
