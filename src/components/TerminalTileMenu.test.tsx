// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AttributedTerminal, RepoChoice } from "../lib/terminalMenu";
import {
  TerminalMenuDataContext,
  TerminalTileMenu,
  type TerminalMenuData,
  type TileActions,
} from "./TerminalTileMenu";

// The contract under test is the tile dropdown: it must list EVERY terminal
// (it is the fleet's only inventory now the tab strip is gone), its ✕ must
// close a terminal WITHOUT closing the menu, and the whole panel must portal
// to document.body — the dock wrapper's containment would clip a panel left
// inside it (that regression is still live; the assertion carries over from
// the deleted RepoBubbles test).

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
// jsdom has no scrollIntoView; the roving selection calls it on move.
HTMLElement.prototype.scrollIntoView = () => {};

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

const row = (
  id: string,
  extra: Partial<AttributedTerminal> = {},
): AttributedTerminal => ({
  id,
  dir: `/Users/dev/redline`,
  label: `${id} 1`,
  held: false,
  unseen: false,
  tile: null,
  repo: { path: "/Users/dev/redline", name: "redline" },
  subPath: "",
  ...extra,
});

const repoChoice = (name: string, count: number): RepoChoice => ({
  path: `/Users/dev/${name}`,
  name,
  count,
});

function makeActions(): TileActions {
  return {
    onPick: vi.fn(),
    onCloseTerminal: vi.fn(),
    onNewHere: vi.fn(),
    onNewHome: vi.fn(),
    onNewRepo: vi.fn(),
    onZoomTile: vi.fn(),
    onFocusTile: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onHintTile: vi.fn(),
    onRefreshCwds: vi.fn(),
  };
}

function mount(
  data: Partial<TerminalMenuData>,
  actions: TileActions,
  onClose: () => void = () => {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const value: TerminalMenuData = {
    rows: [],
    repos: [],
    homePath: "/Users/dev",
    ...data,
  };
  act(() => {
    root.render(
      createElement(
        TerminalMenuDataContext.Provider,
        { value },
        createElement(TerminalTileMenu, {
          tile: 0,
          dir: "/Users/dev/redline/src",
          zoomed: false,
          actions,
          panelProps: { style: {}, panelRef: () => {} },
          onClose,
        }),
      ),
    );
  });
  return { container, root };
}

const menu = () => document.body.querySelector("[role='menu']");
const rowsIn = (m: Element) =>
  [...m.querySelectorAll("[role='menuitem']")].map((r) => r.textContent ?? "");

describe("terminal tile menu", () => {
  it("portals to document.body — the dock's containment would clip it in place", () => {
    const { container } = mount({ rows: [row("redline")] }, makeActions());
    const m = menu();
    expect(m).not.toBeNull();
    expect(container.contains(m!)).toBe(false);
    expect(m!.parentElement).toBe(document.body);
  });

  it("lists EVERY terminal — tiled, untiled, and repo-less — with its state", () => {
    const { } = mount(
      {
        rows: [
          row("redline", { tile: 0, work: "Fix the tile header", held: true }),
          row("api", { tile: 1, unseen: true, subPath: "src" }),
          // Untiled and outside every repo: the old bubble strip dropped this
          // one; the menu MUST keep it reachable.
          row("zsh", { repo: null, dir: "/opt/homebrew" }),
        ],
        repos: [repoChoice("redline", 2), repoChoice("polis", 0)],
      },
      makeActions(),
    );
    const texts = rowsIn(menu()!);
    expect(texts[0]).toContain("redline 1");
    expect(texts[0]).toContain("plan held");
    expect(texts[0]).toContain("Fix the tile header");
    expect(texts[0]).toContain("on screen");
    expect(texts[1]).toContain("api 1");
    expect(texts[1]).toContain("new output");
    expect(texts[1]).toContain("src");
    expect(texts[2]).toContain("zsh 1");
    expect(texts[2]).toContain("/opt/homebrew");
    // Repo rows with their counts, plus the fixed verbs.
    const all = texts.join("\n");
    expect(all).toContain("2 terminals");
    expect(all).toContain("no terminals");
    expect(all).toContain("New terminal here");
    expect(all).toContain("New terminal in home");
    expect(all).toContain("Zoom this tile");
  });

  it("picking a row targets THIS tile and closes the menu", () => {
    const actions = makeActions();
    const onClose = vi.fn();
    mount({ rows: [row("redline", { tile: 2 })] }, actions, onClose);
    const body = menu()!.querySelector("[role='menuitem']") as HTMLButtonElement;
    act(() => body.click());
    expect(actions.onPick).toHaveBeenCalledWith(0, "redline");
    expect(onClose).toHaveBeenCalled();
  });

  it("the ✕ closes that terminal and LEAVES THE MENU OPEN (closing several is a real errand)", () => {
    const actions = makeActions();
    const onClose = vi.fn();
    mount({ rows: [row("redline")] }, actions, onClose);
    const x = menu()!.querySelector(
      "button[aria-label='Close redline 1']",
    ) as HTMLButtonElement;
    expect(x).not.toBeNull();
    act(() => x.click());
    expect(actions.onCloseTerminal).toHaveBeenCalledWith("redline");
    expect(onClose).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("hovering a tiled row outlines that tile; leaving clears it", () => {
    const actions = makeActions();
    mount({ rows: [row("redline", { tile: 3 })] }, actions);
    const item = menu()!.querySelector(".rl-menu-item") as HTMLElement;
    act(() => {
      item.dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true, relatedTarget: null }),
      );
    });
    expect(actions.onHintTile).toHaveBeenCalledWith(3);
    act(() => {
      item.dispatchEvent(
        new MouseEvent("pointerout", { bubbles: true, relatedTarget: null }),
      );
    });
    expect(actions.onHintTile).toHaveBeenCalledWith(null);
  });

  it("shows the filter only at ≥12 terminals, and one query filters BOTH sections", () => {
    const few = mount({ rows: [row("redline")] }, makeActions());
    expect(document.body.querySelector("input[aria-label*='Filter']")).toBeNull();
    act(() => few.root.unmount());
    document.body.innerHTML = "";

    const many = Array.from({ length: 12 }, (_, i) =>
      row(`t${i}`, { label: i === 0 ? "polis 1" : `redline ${i}` }),
    );
    mount(
      { rows: many, repos: [repoChoice("polis", 1), repoChoice("redline", 11)] },
      makeActions(),
    );
    const input = document.body.querySelector(
      "input[aria-label*='Filter']",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => {
      // React reads the input through its onChange — set value natively.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "polis");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const texts = rowsIn(menu()!).join("\n");
    expect(texts).toContain("polis 1");
    expect(texts).not.toContain("redline 3");
    // The repo section filtered through the same matcher.
    expect(texts).toContain("polis");
    expect(texts).not.toContain("11 terminals");
  });

  it("arrows rove and Enter activates — the menu is the only route to untiled terminals", () => {
    const actions = makeActions();
    const onClose = vi.fn();
    mount({ rows: [row("a"), row("b")] }, actions, onClose);
    const list = menu()!.querySelector("[tabindex='-1']") as HTMLElement;
    const key = (k: string) =>
      act(() => {
        list.dispatchEvent(
          new KeyboardEvent("keydown", { key: k, bubbles: true }),
        );
      });
    key("ArrowDown");
    key("Enter");
    expect(actions.onPick).toHaveBeenCalledWith(0, "b");
    expect(onClose).toHaveBeenCalled();
  });
});
