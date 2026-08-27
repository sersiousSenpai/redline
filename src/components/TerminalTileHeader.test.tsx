// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// jsdom has no canvas; the Julia-mark rasterizer is not what's under test.
vi.mock("../lib/repoMarkImage", () => ({ markImage: () => null }));

import { HELD_RED } from "../lib/terminalMenu";
import { TILE_HEADER_H } from "../lib/tileGrid";
import type { TileActions } from "./TerminalTileMenu";
import { TerminalTileHeader, type TerminalIdentity } from "./TerminalTileHeader";

// The contracts under test are the reflow guards: the header is TILE_HEADER_H
// with a 2px bottom border in BOTH focus states (a 1px↔2px swap would change
// the tile's content box, reflow xterm and fire a pty_resize on every focus
// change), and its ▾ menu portals to document.body (the dock's containment
// would clip it in place — the regression the old bubble test kept dead).

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
HTMLElement.prototype.scrollIntoView = () => {};

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

const identity: TerminalIdentity = {
  id: "t1",
  label: "redline 2",
  icon: {
    src: null,
    mark: { cx: 0, cy: 0, view: 1, rot: 0, hue: 200 },
    tint: "hsl(200 55% 45%)",
  },
  repoRoot: "~/redline",
  dir: "/Users/dev/redline/src",
};

function makeActions(): TileActions {
  return {
    onPick: vi.fn(),
    onCloseTerminal: vi.fn(),
    onNewHere: vi.fn(),
    onNewHome: vi.fn(),
    onNewRepo: vi.fn(),
    onZoomTile: vi.fn(),
    onFocusTile: vi.fn(),
    onHintTile: vi.fn(),
    onRefreshCwds: vi.fn(),
  };
}

function mount(
  props: Partial<Parameters<typeof TerminalTileHeader>[0]> = {},
  actions: TileActions = makeActions(),
): { container: HTMLDivElement; root: Root; actions: TileActions } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(TerminalTileHeader, {
        tile: 1,
        identity,
        focused: false,
        overflow: null,
        zoomed: false,
        actions,
        ...props,
      }),
    );
  });
  return { container, root, actions };
}

const head = (c: HTMLElement) => c.querySelector(".rl-tile-head") as HTMLElement;

/** jsdom normalises an inline colour to `rgb(r, g, b)`; derive the expected
 *  string from the constant so a palette change can't silently pass. */
const hexToRgb = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

describe("terminal tile header", () => {
  it("keeps TILE_HEADER_H and a 2px border in BOTH focus states — no reflow on focus change", () => {
    const blurred = mount({ focused: false });
    const blurredEl = head(blurred.container);
    expect(blurredEl.style.height).toBe(`${TILE_HEADER_H}px`);
    expect(blurredEl.style.borderBottom).toContain("2px");

    const focused = mount({ focused: true });
    const focusedEl = head(focused.container);
    expect(focusedEl.style.height).toBe(`${TILE_HEADER_H}px`);
    expect(focusedEl.style.borderBottom).toContain("2px");
  });

  it("the identity chip opens the tile menu, portalled to document.body, refreshing cwds", () => {
    const { container, actions } = mount();
    expect(document.body.querySelector("[role='menu']")).toBeNull();
    const chip = container.querySelector(
      "button[aria-haspopup='menu']",
    ) as HTMLButtonElement;
    act(() => chip.click());
    const menu = document.body.querySelector("[role='menu']");
    expect(menu).not.toBeNull();
    expect(container.contains(menu!)).toBe(false);
    expect(menu!.parentElement).toBe(document.body);
    expect(actions.onRefreshCwds).toHaveBeenCalled();
  });

  it("× closes this terminal; no tile carries a dock-fullscreen button", () => {
    const { container, actions } = mount({ focused: false });
    const x = container.querySelector(
      "button[aria-label='Close redline 2']",
    ) as HTMLButtonElement;
    act(() => x.click());
    expect(actions.onCloseTerminal).toHaveBeenCalledWith("t1");

    // Dock fullscreen moved to the terminal divider's centre pill. A tile is
    // the wrong home for a whole-dock control, and the focused tile's `⤢` was
    // the only thing standing between the two meanings of that glyph.
    expect(
      container.querySelector("button[aria-label*='Fullscreen']"),
    ).toBeNull();
    const focused = mount({ focused: true });
    expect(
      focused.container.querySelector("button[aria-label*='Fullscreen']"),
    ).toBeNull();
  });

  it("renders what the terminal is working on, in HELD_RED when a plan is held", () => {
    const plain = mount({ workText: "npm test", workHeld: false });
    expect(plain.container.textContent).toContain("npm test");
    const line = plain.container.querySelector(
      "span[title='npm test']",
    ) as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.style.color).not.toBe("");

    const held = mount({ workText: "Rework the dock", workHeld: true });
    const heldLine = held.container.querySelector(
      "span[title='Rework the dock']",
    ) as HTMLElement;
    // The menu row's grammar: a held plan is the one claim Redline can make
    // outright, so it takes the intercept red.
    expect(heldLine.style.color).toBe(hexToRgb(HELD_RED));
  });

  it("falls back to a bare spacer when the terminal has volunteered nothing", () => {
    // Absent, not padded with a guess — the header must not invent work.
    const { container } = mount({ workText: null });
    expect(container.querySelector("span[title]")).toBeNull();
    expect(head(container).querySelector("span.flex-1")).not.toBeNull();
  });

  it("shows the overflow pip with its tone, on demand only", () => {
    const none = mount({ overflow: null });
    expect(none.container.textContent).not.toContain("●");

    const { container } = mount({
      focused: true,
      overflow: { count: 3, tone: "held" },
    });
    expect(container.textContent).toContain("●3");
  });

  it("double-click on the strip zooms; on a button it does not", () => {
    const { container, actions } = mount();
    const el = head(container);
    act(() => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(actions.onZoomTile).toHaveBeenCalledWith(1);

    const again = mount();
    const chip = again.container.querySelector(
      "button[aria-haspopup='menu']",
    ) as HTMLButtonElement;
    act(() => {
      chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(again.actions.onZoomTile).not.toHaveBeenCalled();
  });
});
