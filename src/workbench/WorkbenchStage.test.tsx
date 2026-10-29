// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyWorkbench, type AnyPane } from "./model";
import { reduce } from "./reducer";
import { createWorkbenchStore, type WorkbenchStore } from "./store";
import { isResizing } from "../lib/resizeSession";
import { WorkbenchStage } from "./WorkbenchStage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let store: WorkbenchStore;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  let s = emptyWorkbench();
  s = reduce(s, { type: "openTab", pane: { kind: "door", data: { draftKey: "d1" } }, tabId: "t1", paneId: "p1" });
  s = reduce(s, { type: "openTab", pane: { kind: "file", data: { path: "/a.ts" } }, tabId: "t2", paneId: "p2" });
  s = reduce(s, { type: "selectTab", tabId: "t1" });
  store = createWorkbenchStore(s, reduce);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const renderPane = (pane: AnyPane) => <input data-pane-input={pane.id} aria-label={pane.id} />;
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

describe("focus follows the tab", () => {
  it("a tab hidden gives up the focus it held, and the tab shown takes the caret", async () => {
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} />));
    await act(async () => store.dispatch({ type: "selectTab", tabId: "t2" }));
    await frame();
    const door = host.querySelector<HTMLInputElement>("[data-pane-input=p1]")!;
    await act(async () => store.dispatch({ type: "selectTab", tabId: "t1" }));
    await frame();
    door.focus();
    expect(document.activeElement).toBe(door);
    // `inert` alone leaves this focus where it is: the hidden door would
    // go on taking keystrokes.
    await act(async () => store.dispatch({ type: "selectTab", tabId: "t2" }));
    expect(document.activeElement).not.toBe(door);
    await frame();
    expect(document.activeElement).toBe(host.querySelector(".rl-wb-pane[data-pane-kind=file]"));
  });

  it("never takes the caret from something live", async () => {
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} />));
    await act(async () => store.dispatch({ type: "selectTab", tabId: "t2" }));
    await act(async () => store.dispatch({ type: "selectTab", tabId: "t1" }));
    elsewhere.focus();
    await act(async () => store.dispatch({ type: "selectTab", tabId: "t2" }));
    await frame();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe("a caret nobody can see", () => {
  it("a focus held in an undrawn layer (a hidden terminal's textarea) is stray: the shown tab's pane takes the caret", async () => {
    await act(async () => store.dispatch({ type: "openTab", pane: { kind: "servers", data: {} }, tabId: "t2" }));
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} />));
    await act(async () => store.dispatch({ type: "selectTab", tabId: "t1" }));
    await act(async () => store.dispatch({ type: "selectTab", tabId: "t2" }));
    const layer = document.createElement("div");
    const textarea = document.createElement("textarea");
    layer.append(textarea);
    document.body.append(layer);
    textarea.focus();
    layer.style.display = "none";
    await act(async () => store.dispatch({ type: "selectTab", tabId: "t1" }));
    await act(async () => { await new Promise((done) => requestAnimationFrame(() => done(null))); });
    expect(document.activeElement).not.toBe(textarea);
    layer.remove();
  });
});

describe("the tile's divider", () => {
  const split = async () => {
    await act(async () => store.dispatch({ type: "splitPane", paneId: "p1", direction: "row", pane: { kind: "servers", data: {} }, newPaneId: "sv" }));
    let dragging: boolean[] = [];
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} onSplitDragging={(d) => dragging.push(d)} />));
    const divider = host.querySelector<HTMLElement>(".rl-wb-tab-body:not([data-hidden]) .rl-split-divider")!;
    expect(divider).not.toBeNull();
    const weights = () => {
      const st = store.getState();
      const root = st.sets[st.activeKey]!.tabs.t1.root;
      return "split" in root ? root.weights : null;
    };
    return { divider, weights, dragging: () => dragging, reset: () => (dragging = []) };
  };
  const pointer = (type: string, x = 0) => {
    const ev = new MouseEvent(type, { bubbles: true, clientX: x }) as MouseEvent & { pointerId: number };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    return ev;
  };

  it("a cancelled drag closes its resize session and puts the split back", async () => {
    const { divider, weights, dragging } = await split();
    const before = weights();
    await act(async () => { divider.dispatchEvent(pointer("pointerdown", 10)); });
    expect(isResizing()).toBe(true);
    await act(async () => { window.dispatchEvent(pointer("pointermove", 400)); });
    await act(async () => { window.dispatchEvent(pointer("pointercancel")); });
    expect(isResizing()).toBe(false);
    expect(weights()).toEqual(before);
    expect(dragging()).toEqual([true, false]);
  });

  it("Esc mid-drag puts the split back, ends the session, and is the drag's alone", async () => {
    const { divider, weights, dragging } = await split();
    const before = weights();
    const first = divider.previousElementSibling as HTMLElement;
    const basis = first.style.flexGrow;
    const bystander = vi.fn();
    window.addEventListener("keydown", bystander);
    await act(async () => { divider.dispatchEvent(pointer("pointerdown", 10)); });
    await act(async () => { window.dispatchEvent(pointer("pointermove", 400)); });
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(esc); });
    window.removeEventListener("keydown", bystander);
    expect(esc.defaultPrevented).toBe(true);
    expect(bystander).not.toHaveBeenCalled();
    expect(isResizing()).toBe(false);
    expect(weights()).toEqual(before);
    expect(first.style.flexGrow).toBe(basis);
    expect(dragging()).toEqual([true, false]);
    // A release afterwards commits nothing.
    await act(async () => { window.dispatchEvent(pointer("pointerup")); });
    expect(weights()).toEqual(before);
  });

  it("a lost capture ends it too, once; a release after it changes nothing", async () => {
    const { divider, weights, dragging } = await split();
    const before = weights();
    await act(async () => { divider.dispatchEvent(pointer("pointerdown", 10)); });
    await act(async () => { divider.dispatchEvent(pointer("lostpointercapture")); });
    await act(async () => { window.dispatchEvent(pointer("pointerup")); });
    expect(isResizing()).toBe(false);
    expect(weights()).toEqual(before);
    expect(dragging()).toEqual([true, false]);
  });

  it("a release commits the share, and ends the session once", async () => {
    const { divider, weights, dragging } = await split();
    await act(async () => { divider.dispatchEvent(pointer("pointerdown", 10)); });
    await act(async () => { window.dispatchEvent(pointer("pointerup")); });
    await act(async () => { divider.dispatchEvent(pointer("lostpointercapture")); });
    expect(isResizing()).toBe(false);
    expect(weights()).not.toBeNull();
    expect(dragging()).toEqual([true, false]);
  });
});

describe("any split tree (W5): SplitView", () => {
  const pointer = (type: string, x = 0, y = 0) => {
    const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }) as MouseEvent & { pointerId: number };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    return ev;
  };
  const body = () => host.querySelector<HTMLElement>(".rl-wb-tab-body:not([data-hidden])")!;
  /** `el`'s own children matching `css` (jsdom's `:scope >` is unreliable). */
  const kids = (el: Element, css: string) => [...el.children].filter((c): c is HTMLElement => c.matches(css));
  /** p1 | sv | (f / g): a row of three, its last a column of two. */
  const tree = async () => {
    await act(async () => {
      store.dispatch({ type: "splitPane", paneId: "p1", direction: "row", pane: { kind: "servers", data: {} }, newPaneId: "sv" });
      store.dispatch({ type: "splitPane", paneId: "sv", direction: "row", pane: { kind: "file", data: { path: "/f" } }, newPaneId: "f" });
      store.dispatch({ type: "splitPane", paneId: "f", direction: "column", pane: { kind: "file", data: { path: "/g" } }, newPaneId: "g" });
    });
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} />));
  };
  const weights = (path: number[] = []) => {
    const st = store.getState();
    let node = st.sets[st.activeKey]!.tabs.t1.root;
    for (const i of path) node = "split" in node ? node.children[i] : node;
    return "split" in node ? node.weights : null;
  };

  it("renders every child of an n-ary split with a divider in each gap, nested directions too", async () => {
    await tree();
    const outer = kids(body(), ".rl-wb-split")[0];
    expect(outer.dataset.splitArity).toBe("3");
    expect(outer.classList.contains("flex-row")).toBe(true);
    expect(kids(outer, ".rl-split-divider")).toHaveLength(2);
    const inner = outer.querySelector<HTMLElement>(".rl-wb-split .rl-wb-split")!;
    expect(inner.classList.contains("flex-col")).toBe(true);
    expect(kids(inner, ".rl-split-divider")).toHaveLength(1);
    expect([...body().querySelectorAll<HTMLElement>(".rl-wb-pane")].map((p) => p.dataset.paneId)).toEqual(["p1", "sv", "f", "g"]);
    // Each child's share is its flex-grow.
    const cells = kids(outer, ".rl-wb-split-cell");
    expect(cells.map((c) => Number(c.style.flexGrow))).toEqual(weights());
  });

  it("a divider moves only the pair either side of it, and keeps each at 10 %", async () => {
    await tree();
    const outer = kids(body(), ".rl-wb-split")[0];
    const cells = kids(outer, ".rl-wb-split-cell");
    // The row is 1000 px of cells: 500 | 250 | 250 (+ two 6 px dividers).
    const lefts = [0, 506, 762];
    const widths = [500, 250, 250];
    cells.forEach((c, i) => {
      c.getBoundingClientRect = () => ({ left: lefts[i], top: 0, width: widths[i], height: 600, right: lefts[i] + widths[i], bottom: 600, x: lefts[i], y: 0, toJSON: () => ({}) }) as DOMRect;
    });
    const before = weights()!;
    const second = kids(outer, ".rl-split-divider")[1];
    await act(async () => { second.dispatchEvent(pointer("pointerdown", 759)); });
    // Dragged far right: the third child stops at 10 % of the whole split.
    await act(async () => { window.dispatchEvent(pointer("pointermove", 2000)); });
    await act(async () => { window.dispatchEvent(pointer("pointerup", 2000)); });
    const after = weights()!;
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[2]).toBeCloseTo(0.1);
    expect(after[1]).toBeCloseTo(before[1] + before[2] - 0.1);
    // The nested column was not touched.
    expect(weights([2])).toEqual([0.5, 0.5]);
  });

  it("a double-click evens the pair; ⌘⌥='s equalize evens the whole tree", async () => {
    await tree();
    await act(async () => store.dispatch({ type: "resizeSplit", path: [], weights: [0.6, 0.3, 0.1] }));
    const outer = kids(body(), ".rl-wb-split")[0];
    const first = kids(outer, ".rl-split-divider")[0];
    await act(async () => { first.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const w = weights()!;
    expect(w[0]).toBeCloseTo(0.45);
    expect(w[1]).toBeCloseTo(0.45);
    expect(w[2]).toBeCloseTo(0.1);
    await act(async () => store.dispatch({ type: "equalize" }));
    expect(weights()!.every((x) => Math.abs(x - 1 / 3) < 1e-9)).toBe(true);
  });

  it("a zoomed pane fills the tab while the others stay mounted, off screen to their bodies", async () => {
    const seen: Record<string, { visible: boolean; active: boolean }> = {};
    const track = (pane: AnyPane, ctx: { visible: boolean; active: boolean }) => {
      seen[pane.id] = { visible: ctx.visible, active: ctx.active };
      return <input data-pane-input={pane.id} aria-label={pane.id} />;
    };
    await act(async () => store.dispatch({ type: "splitPane", paneId: "p1", direction: "row", pane: { kind: "servers", data: {} }, newPaneId: "sv" }));
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={track} onNewTab={() => {}} />));
    await frame();
    await act(async () => store.dispatch({ type: "zoomPane", paneId: "p1" }));
    await frame();
    expect(body().hasAttribute("data-zoomed")).toBe(true);
    expect(body().querySelector(".rl-wb-pane[data-zoomed]")?.getAttribute("data-pane-id")).toBe("p1");
    expect(body().querySelector("[data-pane-input=sv]")).not.toBeNull();
    expect(seen.sv).toEqual({ visible: false, active: false });
    expect(seen.p1.active).toBe(true);
    await act(async () => store.dispatch({ type: "zoomPane" }));
    await frame();
    expect(body().hasAttribute("data-zoomed")).toBe(false);
    expect(seen.sv.active).toBe(true);
  });
});
