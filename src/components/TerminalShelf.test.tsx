// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SHELF_H, TerminalShelf, type ShelfChip } from "./TerminalShelf";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const chip = (id: string, extra: Partial<ShelfChip> = {}): ShelfChip => ({
  id,
  label: `${id} 1`,
  state: "idle",
  text: null,
  port: null,
  fresh: false,
  ...extra,
});

function mount(chips: ShelfChip[]) {
  const onPlace = vi.fn();
  const onDragStart = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(TerminalShelf, { chips, onPlace, onDragStart })));
  return { container, onPlace, onDragStart };
}

describe("terminal shelf", () => {
  it("renders nothing while every terminal has a tile", () => {
    const { container } = mount([]);
    expect(container.innerHTML).toBe("");
  });

  it("shows each untiled terminal's state, name, words and port", () => {
    const { container } = mount([
      chip("agent", { state: "needs-you", text: "Claude needs your permission" }),
      chip("web", { state: "serving", port: 5173 }),
      chip("vite", { state: "serving", port: 5174, text: "vite" }),
      chip("shell", { fresh: true }),
    ]);
    const strip = container.querySelector("[role='toolbar']") as HTMLElement;
    expect(strip.style.height).toBe(`${SHELF_H}px`);
    const chips = [...strip.querySelectorAll("button")];
    expect(chips.map((c) => c.textContent)).toEqual([
      "agent 1Claude needs your permission",
      "web 1:5173",
      "vite 1vite:5174",
      "shell 1",
    ]);
    expect(chips[0].dataset.termState).toBe("needs-you");
    expect(chips[0].querySelector(".rl-term-badge--pulse")).not.toBeNull();
    // Native titles: the strip clips a CSS tooltip.
    expect(chips[0].title).toContain("needs you");
    expect(chips[0].title).toContain("Claude needs your permission");
    expect(chips[3].hasAttribute("data-fresh")).toBe(true);
    expect(chips[0].hasAttribute("data-fresh")).toBe(false);
  });

  it("a click places the terminal; a primary press offers a drag", () => {
    const { container, onPlace, onDragStart } = mount([chip("a"), chip("b")]);
    const [a, b] = [...container.querySelectorAll("button")];
    act(() => b.click());
    expect(onPlace).toHaveBeenCalledWith("b");
    act(() => {
      a.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      a.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 1 }));
    });
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart).toHaveBeenCalledWith("a", expect.anything());
  });

  it("a vertical wheel scrolls the row sideways", () => {
    const { container } = mount([chip("a"), chip("b")]);
    const strip = container.querySelector("[role='toolbar']") as HTMLElement;
    act(() => {
      strip.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
    });
    expect(strip.scrollLeft).toBe(40);
  });
});
