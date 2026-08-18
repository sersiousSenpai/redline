// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BrowseListItem, BrowseListView } from "../types";

// What this file pins is the panel's two-state contract — no list row means the
// TEMPLATE CHOOSER, a list row means the list — and the rules that make the
// handoff trustworthy: a row is only ever what the backend returned, the
// numbering the user reads is the numbering the quote and the document use,
// and neither handoff empties the list.

/** The fake backend. `list` is the whole store, so a test can assert against
 *  what the commands actually did rather than against a spy call log. */
let list: BrowseListView | null = null;
let nextId = 0;

const item = (kind: string, body: string, sortIdx: number): BrowseListItem => ({
  id: `i${nextId++}`,
  browseId: "b1",
  kind,
  body,
  done: false,
  sortIdx,
  createdAt: 0,
  updatedAt: 0,
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "browse_list_get") return Promise.resolve(list);
    if (cmd === "browse_list_start") {
      list = {
        list: {
          browseId: "b1",
          template: args.template as string,
          title: (args.title as string) ?? null,
          createdAt: 0,
          updatedAt: 0,
        },
        items: list?.items ?? [],
      };
      return Promise.resolve(list);
    }
    if (cmd === "browse_list_add") {
      if (!list) return Promise.reject(new Error("this tab has no list yet"));
      const it = item(
        args.kind as string,
        args.body as string,
        list.items.length,
      );
      list = { ...list, items: [...list.items, it] };
      return Promise.resolve(it);
    }
    if (cmd === "browse_list_update") {
      const found = list?.items.find((x) => x.id === args.id);
      if (!list || !found) return Promise.reject(new Error("that item is gone"));
      const next = {
        ...found,
        ...(args.body !== undefined ? { body: args.body as string } : {}),
        ...(args.kind !== undefined ? { kind: args.kind as string } : {}),
        ...(args.done !== undefined ? { done: args.done as boolean } : {}),
      };
      list = { ...list, items: list.items.map((x) => (x.id === next.id ? next : x)) };
      return Promise.resolve(next);
    }
    if (cmd === "browse_list_clear") {
      list = null;
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import BrowseList from "./BrowseList";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let host: HTMLDivElement;
let root: Root;

/** Buttons only — a wrapper `div` holding one button has the same textContent
 *  and comes first in document order, so a looser selector clicks the div and
 *  the test passes/fails for the wrong reason. Exact match first, then prefix,
 *  which is what reaches the chooser cards (label + blurb in one button). */
const byText = (text: string): HTMLElement | undefined => {
  const buttons = [...host.querySelectorAll<HTMLElement>("button")];
  return (
    buttons.find((el) => el.textContent?.trim() === text) ??
    buttons.find((el) => el.textContent?.trim().startsWith(text))
  );
};

const click = async (el: Element | undefined) => {
  expect(el, "element to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
};

const typeAndEnter = async (text: string) => {
  const ta = host.querySelector("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    ta.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await flush();
};

const render = async (props: Record<string, unknown> = {}) => {
  await act(async () => {
    root.render(
      createElement(BrowseList, {
        browseId: "b1",
        source: { url: "http://localhost:5173/settings", title: "Settings" },
        onClose: () => {},
        ...props,
      } as never),
    );
  });
  await flush();
};

beforeEach(() => {
  list = null;
  nextId = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("BrowseList", () => {
  it("offers the template chooser when the tab has no list", async () => {
    await render();
    expect(host.textContent).toContain("Bugs / Fixes / Improvements");
    expect(host.textContent).toContain("Punch list");
    expect(host.textContent).toContain("Design feedback");
  });

  it("picking a template creates the list and shows its composer", async () => {
    await render();
    await click(byText("Bugs / Fixes / Improvements"));
    expect(list?.list.template).toBe("bugs-fixes-improvements");
    expect(host.querySelector("textarea")).toBeTruthy();
    // The chooser is gone — a list with no items is still a LIST, and bouncing
    // back to the chooser would undo a choice the user just made.
    expect(host.textContent).toContain("Nothing on it yet");
  });

  it("⏎ appends, and the row rendered is the one the backend returned", async () => {
    await render();
    await click(byText("Bugs / Fixes / Improvements"));
    await typeAndEnter("nav overlaps the logo");
    expect(list?.items.map((i) => i.body)).toEqual(["nav overlaps the logo"]);
    expect(host.textContent).toContain("nav overlaps the logo");
    // Section headings come from the template, not from the item.
    expect(host.textContent).toContain("Bug");
  });

  it("ticking done strikes the item through rather than removing it", async () => {
    await render();
    await click(byText("Punch list"));
    await typeAndEnter("do the thing");
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      box.click();
    });
    await flush();
    expect(list?.items[0].done).toBe(true);
    const row = [...host.querySelectorAll<HTMLElement>("button")].find(
      (el) => el.textContent?.trim() === "do the thing",
    );
    expect(row?.style.textDecoration).toBe("line-through");
  });

  it("hands the WHOLE list over, and keeps it afterwards", async () => {
    // It's a working list. The user decides when it's done, not the handoff.
    const sent: string[] = [];
    await render({ onSendToRedline: (md: string) => sent.push(md) });
    await click(byText("Bugs / Fixes / Improvements"));
    await typeAndEnter("nav overlaps the logo");
    await typeAndEnter("empty state has no copy");
    await click(byText("Send to Claude Code ▶"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("nav overlaps the logo");
    expect(sent[0]).toContain("empty state has no copy");
    // Provenance: which tab this came from.
    expect(sent[0]).toContain("http://localhost:5173/settings");
    expect(list?.items).toHaveLength(2);
    expect(host.textContent).toContain("nav overlaps the logo");
  });

  it("quotes an item under the number the panel shows", async () => {
    const quoted: string[] = [];
    await render({ onDiscussItem: (q: string) => quoted.push(q) });
    await click(byText("Punch list"));
    await typeAndEnter("first");
    await typeAndEnter("second");
    // The 💬 on the SECOND row. Both rows carry one; index 1 is the second.
    const chats = host.querySelectorAll('button[title="Ask the page agent about this item"]');
    expect(chats).toHaveLength(2);
    await click(chats[1]);
    expect(quoted[0]).toBe("> Item 2: second\n\n");
  });

  it("clearing drops the list, so the chooser comes back", async () => {
    await render();
    await click(byText("Punch list"));
    await typeAndEnter("do the thing");
    await click(byText("Clear"));
    expect(list).toBeNull();
    expect(host.textContent).toContain("Bugs / Fixes / Improvements");
  });

  it("tells the host whether a list exists, in both directions", async () => {
    // What gates "＋ Add as item" in the page chat: `browse_list_add` refuses
    // an orphan, so offering it without a list could only ever fail.
    const seen: boolean[] = [];
    await render({ onListChanged: (e: boolean) => seen.push(e) });
    expect(seen).toEqual([false]);
    await click(byText("Punch list"));
    expect(seen).toEqual([false, true]);
    await click(byText("Clear"));
    expect(seen).toEqual([false, true, false]);
  });

  it("surfaces a failed write instead of silently doing nothing", async () => {
    await render();
    await click(byText("Punch list"));
    list = null; // the list vanished under us — the add will be refused
    await typeAndEnter("do the thing");
    expect(host.textContent).toContain("no list yet");
  });
});
