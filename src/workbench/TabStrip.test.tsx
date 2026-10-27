// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabStrip, type TabStripItem, type TabStripProps } from "./TabStrip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

const handlers = {
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onReorder: vi.fn(),
  onRename: vi.fn(),
  onNew: vi.fn(),
  onReopen: vi.fn(),
};

const items: TabStripItem[] = [
  { id: "a", kind: "plan", title: "Plan v3", status: "needs" },
  { id: "b", kind: "chat", title: "Agent", status: "working" },
  { id: "c", kind: "terminals", title: "Terminals", status: "idle", count: 4 },
  { id: "d", kind: "file", title: "auth.ts", status: "exited", preview: true },
];

const render = (over: Partial<TabStripProps> = {}) =>
  act(async () =>
    root.render(<TabStrip {...handlers} tabs={items} activeTabId="a" canReopen={false} {...over} />),
  );

const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const tab = (id: string) => tabs().find((el) => el.dataset.tabId === id)!;
const mouse = (type: string, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
const key = (k: string) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
const pointer = (type: string, clientX: number) =>
  Object.assign(mouse(type, { clientX, clientY: 17 }), { pointerId: 1 });
const menuLabels = () =>
  [...document.body.querySelectorAll('[role="menuitem"] .rl-row-menu-label')].map((el) => el.textContent?.trim());

beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the tab strip renders the set", () => {
  it("one tab per item, with its glyph, title and the one status vocabulary", async () => {
    await render();
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs().map((el) => el.dataset.tabId)).toEqual(["a", "b", "c", "d"]);
    for (const el of tabs()) {
      expect(el.querySelector("svg.rl-wb-icon")).not.toBeNull();
      expect(el.title).toBe(el.querySelector(".rl-wb-title")!.textContent);
    }
    // needs you: the amber dot, an HTML element that breathes.
    expect(tab("a").querySelector("i.rl-wb-dot[data-status='needs']")).not.toBeNull();
    expect(tab("a").querySelector(".rl-spinner")).toBeNull();
    // working: the shared spinner, HTML not SVG.
    expect(tab("b").querySelector(".rl-spinner")!.tagName).toBe("SPAN");
    expect(tab("b").querySelector(".rl-wb-dot")).toBeNull();
    // idle: nothing; the count rides after the title.
    expect(tab("c").querySelector(".rl-spinner, .rl-wb-dot")).toBeNull();
    expect(tab("c").querySelector(".rl-wb-count")!.textContent).toBe("4");
    // exited: muted via the tab's own attribute; preview is italic via its own.
    expect(tab("d").dataset.status).toBe("exited");
    expect(tab("d").hasAttribute("data-preview")).toBe(true);
    expect(tab("a").hasAttribute("data-status")).toBe(false);
  });

  it("marks the active tab and roves focus to it", async () => {
    await render();
    expect(tab("a").getAttribute("aria-selected")).toBe("true");
    expect(tab("a").getAttribute("aria-current")).toBe("true");
    expect(tab("a").tabIndex).toBe(0);
    expect(tab("b").getAttribute("aria-selected")).toBe("false");
    expect(tab("b").hasAttribute("aria-current")).toBe(false);
    expect(tab("b").tabIndex).toBe(-1);
  });

  it("the strip is 34px of canvas and the active tab merges into the paper below", () => {
    // The stylesheet rides the component's chunk; read it at the source.
    const css = readCss();
    expect(css).toMatch(/\.rl-wb-strip\s*\{[^}]*height:\s*34px/);
    expect(css).toMatch(/\.rl-wb-tab\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--color-paper\)/);
    expect(css).toMatch(/\.rl-wb-tab\[aria-selected="true"\]\s*\{[^}]*border-bottom-color:\s*var\(--color-paper\)/);
    expect(css).toMatch(/@keyframes rl-wb-pulse\s*\{[^}]*\{\s*opacity[^}]*\}/);
    expect(css).not.toMatch(/content-visibility/);
    for (const cls of [".rl-wb-new", ".rl-wb-drop", ".rl-wb-tab-x"]) {
      expect(css).toContain(`${cls} {`);
    }
    // The stage's structural rules are first-frame CSS: they live in
    // styles.css, beside the kept-tab rule renderHygiene counts.
    const styles = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    for (const cls of [".rl-wb-stage", ".rl-wb-tabs", ".rl-wb-tab-body", ".rl-wb-tab-body[data-hidden]"]) {
      expect(styles).toContain(`${cls} {`);
    }
  });
});

describe("pointer acts", () => {
  it("click selects, the × closes without selecting, middle-click closes", async () => {
    await render();
    await act(async () => tab("b").dispatchEvent(mouse("click")));
    expect(handlers.onSelect).toHaveBeenCalledWith("b");
    handlers.onSelect.mockClear();
    await act(async () => tab("c").querySelector(".rl-wb-tab-x")!.dispatchEvent(mouse("click")));
    expect(handlers.onClose).toHaveBeenCalledWith("c");
    expect(handlers.onSelect).not.toHaveBeenCalled();
    await act(async () => tab("d").dispatchEvent(mouse("auxclick", { button: 1 })));
    expect(handlers.onClose).toHaveBeenLastCalledWith("d");
  });

  it("the + cell opens a new tab", async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>(".rl-wb-new")!.click());
    expect(handlers.onNew).toHaveBeenCalledTimes(1);
  });

  it("a press that travels past 4px drags the tab to the slot under the pointer", async () => {
    await render();
    tabs().forEach((el, i) => {
      el.getBoundingClientRect = () => ({ left: i * 100, right: (i + 1) * 100, width: 100, top: 0, bottom: 34, height: 34, x: i * 100, y: 0, toJSON: () => ({}) }) as DOMRect;
    });
    await act(async () => tab("a").dispatchEvent(pointer("pointerdown", 50)));
    // Within the slop: nothing yet.
    await act(async () => window.dispatchEvent(pointer("pointermove", 53)));
    expect(tab("a").hasAttribute("data-dragging")).toBe(false);
    expect(host.querySelector(".rl-wb-drop")).toBeNull();
    await act(async () => window.dispatchEvent(pointer("pointermove", 260)));
    expect(tab("a").hasAttribute("data-dragging")).toBe(true);
    expect(host.querySelector(".rl-wb-drop")).not.toBeNull();
    await act(async () => window.dispatchEvent(pointer("pointerup", 260)));
    // Past b (centre 150) and c (centre 250), before d (centre 350): slot 2
    // once a is lifted out — b, c, a, d.
    expect(handlers.onReorder).toHaveBeenCalledWith("a", 2);
    expect(host.querySelector(".rl-wb-drop")).toBeNull();
    expect(tab("a").hasAttribute("data-dragging")).toBe(false);
    // The click that lands after a drag is not a select.
    await act(async () => tab("a").dispatchEvent(mouse("click")));
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  it("a press that stays put is a plain select, not a reorder", async () => {
    await render();
    await act(async () => tab("b").dispatchEvent(pointer("pointerdown", 50)));
    await act(async () => window.dispatchEvent(pointer("pointerup", 51)));
    await act(async () => tab("b").dispatchEvent(mouse("click")));
    expect(handlers.onReorder).not.toHaveBeenCalled();
    expect(handlers.onSelect).toHaveBeenCalledWith("b");
  });
});

describe("keyboard", () => {
  it("← → move focus and selection, Delete closes, F2 renames", async () => {
    await render();
    tab("a").focus();
    await act(async () => tab("a").dispatchEvent(key("ArrowRight")));
    expect(handlers.onSelect).toHaveBeenCalledWith("b");
    expect(document.activeElement).toBe(tab("b"));
    await act(async () => tab("b").dispatchEvent(key("ArrowLeft")));
    expect(handlers.onSelect).toHaveBeenLastCalledWith("a");
    expect(document.activeElement).toBe(tab("a"));
    // The first tab has no left neighbour: nothing happens.
    handlers.onSelect.mockClear();
    await act(async () => tab("a").dispatchEvent(key("ArrowLeft")));
    expect(handlers.onSelect).not.toHaveBeenCalled();
    await act(async () => tab("a").dispatchEvent(key("Enter")));
    expect(handlers.onSelect).toHaveBeenCalledWith("a");
    await act(async () => tab("a").dispatchEvent(key("Delete")));
    expect(handlers.onClose).toHaveBeenCalledWith("a");
    await act(async () => tab("a").dispatchEvent(key("F2")));
    expect(tab("a").querySelector("input.rl-wb-rename")).not.toBeNull();
    expect(tab("a").querySelector(".rl-wb-title")).toBeNull();
  });
});

describe("rename", () => {
  const type = async (input: HTMLInputElement, value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("double-click opens the field; Enter saves the new title", async () => {
    await render();
    await act(async () => tab("b").dispatchEvent(mouse("dblclick")));
    const input = tab("b").querySelector<HTMLInputElement>("input.rl-wb-rename")!;
    expect(input).not.toBeNull();
    expect(input.value).toBe("Agent");
    await type(input, "Build agent");
    await act(async () => input.dispatchEvent(key("Enter")));
    expect(handlers.onRename).toHaveBeenCalledWith("b", "Build agent");
    expect(tab("b").querySelector("input")).toBeNull();
    expect(tab("b").querySelector(".rl-wb-title")!.textContent).toBe("Agent");
  });

  it("Escape puts the field away without a write; an emptied title is a cancel", async () => {
    await render();
    await act(async () => tab("b").dispatchEvent(mouse("dblclick")));
    let input = tab("b").querySelector<HTMLInputElement>("input.rl-wb-rename")!;
    await type(input, "Something else");
    await act(async () => input.dispatchEvent(key("Escape")));
    expect(handlers.onRename).not.toHaveBeenCalled();
    expect(tab("b").querySelector("input")).toBeNull();
    await act(async () => tab("b").dispatchEvent(mouse("dblclick")));
    input = tab("b").querySelector<HTMLInputElement>("input.rl-wb-rename")!;
    await type(input, "   ");
    await act(async () => input.dispatchEvent(key("Enter")));
    expect(handlers.onRename).not.toHaveBeenCalled();
  });
});

describe("context menu", () => {
  it("right-click lists Close, Close others, Rename and the moves; Reopen only when allowed", async () => {
    await render();
    await act(async () => tab("b").dispatchEvent(mouse("contextmenu", { clientX: 120, clientY: 20 })));
    expect(menuLabels()).toEqual(["Close", "Close others", "Rename", "Move left", "Move right"]);
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(handlers.onClose).toHaveBeenCalledWith("b");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    await render({ canReopen: true });
    await act(async () => tab("c").dispatchEvent(mouse("contextmenu", { clientX: 220, clientY: 20 })));
    expect(menuLabels()).toContain("Reopen closed tab");
    const reopen = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => el.textContent?.includes("Reopen"))!;
    await act(async () => reopen.click());
    expect(handlers.onReopen).toHaveBeenCalledTimes(1);
  });

  it("a lone tab has no Close others, and the ends cannot move past themselves", async () => {
    await render({ tabs: [items[0]] });
    await act(async () => tab("a").dispatchEvent(mouse("contextmenu", { clientX: 20, clientY: 20 })));
    expect(menuLabels()).toEqual(["Close", "Rename", "Move left", "Move right"]);
    const disabled = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter((el) => el.disabled).map((el) => el.querySelector(".rl-row-menu-label")?.textContent?.trim());
    expect(disabled).toEqual(["Move left", "Move right"]);
  });

  it("Close others closes every other tab; Move right reorders by one slot", async () => {
    await render();
    await act(async () => tab("b").dispatchEvent(mouse("contextmenu", { clientX: 120, clientY: 20 })));
    const item = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => el.querySelector(".rl-row-menu-label")?.textContent?.trim() === label)!;
    await act(async () => item("Close others").click());
    expect(handlers.onClose.mock.calls.map(([id]) => id)).toEqual(["a", "c", "d"]);
    await act(async () => tab("b").dispatchEvent(mouse("contextmenu", { clientX: 120, clientY: 20 })));
    await act(async () => item("Move right").click());
    expect(handlers.onReorder).toHaveBeenCalledWith("b", 2);
  });
});

describe("memoization", () => {
  it("a status tick on one tab re-renders one tab", async () => {
    const renders = new Map<string, number>();
    const { TAB_ICONS } = await import("./TabStrip");
    // Count rows through their glyph: each kind's icon renders once per row
    // render, so a wrapped icon counts that row.
    for (const kind of Object.keys(TAB_ICONS) as (keyof typeof TAB_ICONS)[]) {
      const Real = TAB_ICONS[kind];
      (TAB_ICONS as Record<string, unknown>)[kind] = Object.assign(
        (props: Record<string, unknown>) => {
          renders.set(kind, (renders.get(kind) ?? 0) + 1);
          return <Real {...props} />;
        },
        { displayName: `Counted${kind}` },
      );
    }
    await render();
    renders.clear();
    const ticked = items.map((t) => (t.id === "b" ? { ...t, status: "needs" as const } : t));
    await render({ tabs: ticked });
    expect([...renders.keys()]).toEqual(["chat"]);
  });
});

function readCss(): string {
  return readFileSync(join(process.cwd(), "src", "workbench", "workbench.css"), "utf8");
}
