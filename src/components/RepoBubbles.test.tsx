// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RepoBubble } from "../lib/repoBubbles";

// The contract under test is the hover popover: hovering a bubble that has open
// terminals must, after the open delay, put a menu of those terminals ON
// document.body — the portal matters as much as the menu, because the dock
// wrapper carries `contain: layout paint`, which would clip a `position: fixed`
// panel left inside it (that's the bug this test exists to keep dead).

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom lays nothing out, so every rect is zero and the strip would fit nothing.
// Give buttons a width and their container a generous one.
const rect = (width: number): DOMRect =>
  ({
    width,
    height: 20,
    left: 40,
    right: 40 + width,
    top: 100,
    bottom: 130,
    x: 40,
    y: 100,
    toJSON: () => ({}),
  }) as DOMRect;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return rect(this.tagName === "BUTTON" ? 80 : 600);
    },
  );
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

import { RepoBubbles } from "./RepoBubbles";

const bubble = (
  name: string,
  instances: RepoBubble["instances"] = [],
): RepoBubble => ({ path: `/Users/dev/${name}`, name, instances });

const instance = (
  id: string,
  label: string,
  extra: Partial<RepoBubble["instances"][number]> = {},
) => ({
  id,
  dir: `/Users/dev/redline`,
  label,
  held: false,
  unseen: false,
  pane: null,
  subPath: "",
  ...extra,
});

function mount(
  bubbles: RepoBubble[],
  handlers: {
    onOpenRepo?: (p: string) => void;
    onFocusTerminal?: (id: string) => void;
  } = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(RepoBubbles, {
        bubbles,
        split: false,
        onOpenRepo: handlers.onOpenRepo ?? (() => {}),
        onFocusTerminal: handlers.onFocusTerminal ?? (() => {}),
      }),
    );
  });
  return { container, root };
}

/** React derives enter/leave from over/out at the root, so a raw "pointerenter"
 *  would never reach onPointerEnter. */
const hover = (el: Element) =>
  act(() => {
    el.dispatchEvent(
      new MouseEvent("pointerover", { bubbles: true, relatedTarget: null }),
    );
  });

const unhover = (el: Element) =>
  act(() => {
    el.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: null }),
    );
  });

const tick = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });

/** The visible pills, not the off-screen measurement row. */
const pills = (c: HTMLElement) =>
  [...c.querySelectorAll("button.rl-repo-bubble")].filter(
    (b) => !b.closest("[aria-hidden='true']"),
  );

const menu = () => document.body.querySelector("[role='menu']");

describe("repo bubble hover popover", () => {
  beforeEach(() => vi.useFakeTimers());

  it("opens a menu of that repo's open terminals after the hover delay", async () => {
    const { container } = mount([
      bubble("redline", [
        instance("t1", "redline 1"),
        instance("t2", "redline 2", { subPath: "src/components", unseen: true }),
      ]),
    ]);

    const pill = pills(container)[0];
    expect(pill).toBeTruthy();
    expect(menu()).toBeNull();

    await hover(pill);
    // Nothing yet — a pointer crossing the strip must not fire panels.
    await tick(200);
    expect(menu()).toBeNull();

    await tick(200);
    const m = menu();
    expect(m).not.toBeNull();
    // Portalled OUT of the component's own subtree, or `contain: layout paint`
    // on the dock wrapper would clip it.
    expect(container.contains(m!)).toBe(false);
    expect(m!.parentElement).toBe(document.body);

    const rows = [...m!.querySelectorAll("[role='menuitem']")].map(
      (r) => r.textContent ?? "",
    );
    expect(rows[0]).toContain("redline 1");
    expect(rows[0]).toContain("at repo root");
    expect(rows[1]).toContain("redline 2");
    expect(rows[1]).toContain("src/components");
    expect(rows[1]).toContain("new output");
  });

  it("says what each terminal is working on, when it knows", async () => {
    const { container } = mount([
      bubble("redline", [
        instance("t1", "redline 1", {
          held: true,
          work: "Repo bubbles in the terminal tab bar",
        }),
        instance("t2", "redline 2", {
          subPath: "src-tauri",
          work: "cargo test",
        }),
        // Nothing volunteered — the row stays two lines rather than guessing.
        instance("t3", "redline 3", { subPath: "docs" }),
      ]),
    ]);

    await hover(pills(container)[0]);
    await tick(400);
    const rows = [...menu()!.querySelectorAll("[role='menuitem']")].map(
      (r) => r.textContent ?? "",
    );

    expect(rows[0]).toContain("Repo bubbles in the terminal tab bar");
    expect(rows[1]).toContain("cargo test");
    expect(rows[2]).toContain("redline 3");
    expect(rows[2]).toContain("docs");
    // No stray work line on the terminal that never said anything.
    expect(rows[2]).not.toContain("cargo");
  });

  it("focuses the terminal whose row is clicked", async () => {
    const onFocusTerminal = vi.fn();
    const { container } = mount(
      [bubble("redline", [instance("t1", "redline 1")])],
      { onFocusTerminal },
    );

    await hover(pills(container)[0]);
    await tick(400);
    const row = menu()!.querySelector("[role='menuitem']") as HTMLButtonElement;
    await act(() => {
      row.click();
    });

    expect(onFocusTerminal).toHaveBeenCalledWith("t1");
    expect(menu()).toBeNull();
  });

  it("holds the menu open long enough to walk the pointer into it", async () => {
    const { container } = mount([
      bubble("redline", [instance("t1", "redline 1")]),
    ]);

    await hover(pills(container)[0]);
    await tick(400);
    expect(menu()).not.toBeNull();

    await unhover(pills(container)[0]);
    await tick(100);
    // Still up — the grace period is what lets the pointer cross the 6px gap.
    expect(menu()).not.toBeNull();

    await hover(menu()!);
    await tick(400);
    expect(menu()).not.toBeNull();
  });

  it("closes once the pointer leaves for good", async () => {
    const { container } = mount([
      bubble("redline", [instance("t1", "redline 1")]),
    ]);

    await hover(pills(container)[0]);
    await tick(400);
    await unhover(pills(container)[0]);
    await tick(200);

    expect(menu()).toBeNull();
  });

  it("shows no panel for a repo with nothing open — the path rides a tooltip", async () => {
    const { container } = mount([bubble("api")]);
    const pill = pills(container)[0];

    await hover(pill);
    await tick(600);

    expect(menu()).toBeNull();
    expect(pill.getAttribute("title")).toContain("/Users/dev/api");
  });

  it("opens a new terminal in the repo when the pill itself is clicked", async () => {
    const onOpenRepo = vi.fn();
    const { container } = mount(
      [bubble("redline", [instance("t1", "redline 1")])],
      { onOpenRepo },
    );

    await act(() => {
      (pills(container)[0] as HTMLButtonElement).click();
    });
    expect(onOpenRepo).toHaveBeenCalledWith("/Users/dev/redline");
  });
});
