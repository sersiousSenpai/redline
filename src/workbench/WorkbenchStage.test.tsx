// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PANE_MIN_W, emptyWorkbench, type AnyPane } from "./model";
import { DOOR_MIN_W } from "../lib/paneLayout";
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
    // The row is 10 000 px of cells: 5000 | 2500 | 2500 (+ two 1 px seams),
    // wide enough that 10 % binds before any pane's own minimum (D40).
    const lefts = [0, 5001, 7502];
    const widths = [5000, 2500, 2500];
    cells.forEach((c, i) => {
      c.getBoundingClientRect = () => ({ left: lefts[i], top: 0, width: widths[i], height: 600, right: lefts[i] + widths[i], bottom: 600, x: lefts[i], y: 0, toJSON: () => ({}) }) as DOMRect;
    });
    const before = weights()!;
    const second = kids(outer, ".rl-split-divider")[1];
    await act(async () => { second.dispatchEvent(pointer("pointerdown", 7501)); });
    // Dragged far right: the third child stops at 10 % of the whole split.
    await act(async () => { window.dispatchEvent(pointer("pointermove", 20000)); });
    await act(async () => { window.dispatchEvent(pointer("pointerup", 20000)); });
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

describe("merge by drag and the pane menu (W5)", () => {
  const at = (type: string, clientX: number, clientY: number) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY }) as MouseEvent & { pointerId: number };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    return ev;
  };
  const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const strip = async () => {
    for (let i = 0; i < 20 && !host.querySelector('[role="tab"]'); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(host.querySelector('[role="tab"]')).not.toBeNull();
  };

  it("a tab dropped on a pane's right quarter merges beside it, the zone lit while it hangs there", async () => {
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} />));
    await strip();
    host.querySelector<HTMLElement>('[role="tablist"]')!.getBoundingClientRect = rect(0, 0, 800, 34);
    host.querySelector<HTMLElement>(".rl-wb-tabs")!.getBoundingClientRect = rect(0, 34, 800, 600);
    host.querySelector<HTMLElement>('.rl-wb-tab-body[data-wb-tab="t1"] .rl-wb-pane[data-pane-id="p1"]')!.getBoundingClientRect = rect(0, 34, 800, 600);
    const t2 = host.querySelector<HTMLElement>('[role="tab"][data-tab-id="t2"]')!;
    await act(async () => { t2.dispatchEvent(at("pointerdown", 150, 17)); });
    await act(async () => { window.dispatchEvent(at("pointermove", 760, 300)); });
    const zone = document.body.querySelector<HTMLElement>(".rl-wb-drop-zone")!;
    expect(zone.dataset.dropEdge).toBe("right");
    expect(zone.dataset.dropPane).toBe("p1");
    // Fixed on the body, in the window's coordinates.
    expect([zone.style.left, zone.style.top, zone.style.width, zone.style.height]).toEqual(["400px", "34px", "400px", "600px"]);
    // The webviews show their snapshots while a tab hangs over the stage.
    expect(isResizing()).toBe(true);
    await act(async () => { window.dispatchEvent(at("pointerup", 760, 300)); });
    expect(isResizing()).toBe(false);
    expect(document.body.querySelector(".rl-wb-drop-zone")).toBeNull();
    const s = store.getState().sets.home!;
    expect(s.order).toEqual(["t1"]);
    expect(s.tabs.t1.root).toEqual({ split: true, direction: "row", children: [{ pane: "p1" }, { pane: "p2" }], weights: [0.5, 0.5] });
  });

  it("the tab in front cannot merge into itself: no zone, nothing moves", async () => {
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} />));
    await strip();
    host.querySelector<HTMLElement>('[role="tablist"]')!.getBoundingClientRect = rect(0, 0, 800, 34);
    host.querySelector<HTMLElement>('.rl-wb-tab-body[data-wb-tab="t1"] .rl-wb-pane[data-pane-id="p1"]')!.getBoundingClientRect = rect(0, 34, 800, 600);
    const before = store.getState();
    const t1 = host.querySelector<HTMLElement>('[role="tab"][data-tab-id="t1"]')!;
    await act(async () => { t1.dispatchEvent(at("pointerdown", 50, 17)); });
    await act(async () => { window.dispatchEvent(at("pointermove", 60, 300)); });
    expect(document.body.querySelector(".rl-wb-drop-zone")).toBeNull();
    await act(async () => { window.dispatchEvent(at("pointerup", 60, 300)); });
    expect(store.getState()).toBe(before);
    expect(isResizing()).toBe(false);
  });

  it("the strip's ⋯ moves the focused pane of a split to a new tab, and zooms it", async () => {
    await act(async () => store.dispatch({ type: "splitPane", paneId: "p1", direction: "row", pane: { kind: "servers", data: {} }, newPaneId: "sv" }));
    const onSplit = vi.fn();
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} onSplit={onSplit} />));
    await strip();
    const open = async () => act(async () => host.querySelector<HTMLButtonElement>(".rl-wb-pane-menu")!.click());
    const pick = async (label: string) => act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => el.textContent?.includes(label))!.click());
    await open();
    expect([...document.body.querySelectorAll('[role="menuitem"] .rl-row-menu-label')].map((e) => e.textContent)).toEqual(["Split right", "Split down", "Zoom the pane", "Even out the splits", "Move to a new tab", "Close pane"]);
    await pick("Split down");
    expect(onSplit).toHaveBeenCalledWith("column");
    await open();
    await pick("Zoom the pane");
    expect(store.getState().sets.home!.tabs.t1.zoomed).toBe("sv");
    await open();
    await pick("Move to a new tab");
    const s = store.getState().sets.home!;
    expect(s.tabs.t1.root).toEqual({ pane: "p1" });
    expect(s.tabs[s.activeTabId!].root).toEqual({ pane: "sv" });
  });
});

describe("the stage's pane keys (W5)", () => {
  const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const press = (code: string, over: KeyboardEventInit) => {
    const ev = new KeyboardEvent("keydown", { code, key: code, bubbles: true, cancelable: true, ...over });
    act(() => { document.body.dispatchEvent(ev); });
    return ev;
  };
  it("⌃⌘ + an arrow focuses the pane that way on screen; ⌘⌥= evens the tab; a lone pane leaves both alone", async () => {
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} />));
    const lone = press("ArrowRight", { metaKey: true, ctrlKey: true });
    expect(lone.defaultPrevented).toBe(false);
    await act(async () => store.dispatch({ type: "splitPane", paneId: "p1", direction: "row", pane: { kind: "servers", data: {} }, newPaneId: "sv" }));
    host.querySelector<HTMLElement>('.rl-wb-pane[data-pane-id="p1"]')!.getBoundingClientRect = rect(0, 34, 400, 600);
    host.querySelector<HTMLElement>('.rl-wb-pane[data-pane-id="sv"]')!.getBoundingClientRect = rect(406, 34, 400, 600);
    const focus = () => store.getState().sets.home!.tabs.t1.focusedPaneId;
    expect(focus()).toBe("sv");
    const left = press("ArrowLeft", { metaKey: true, ctrlKey: true });
    expect(left.defaultPrevented).toBe(true);
    expect(focus()).toBe("p1");
    // ⌘⌥← is the tab cycle's, never the pane's.
    press("ArrowRight", { metaKey: true, altKey: true });
    expect(focus()).toBe("p1");
    await act(async () => store.dispatch({ type: "resizeSplit", path: [], weights: [0.7, 0.3] }));
    press("Equal", { metaKey: true, altKey: true });
    const root0 = store.getState().sets.home!.tabs.t1.root;
    expect("split" in root0 && root0.weights).toEqual([0.5, 0.5]);
  });
});

describe("a door at rest in a split (W5)", () => {
  it("plan + door, the plan focused: the door shows its box and its recents, never an empty plate; a press wakes it", async () => {
    const { DoorPane } = await import("./panes/door");
    const recents = [
      { kind: "plan" as const, id: "s1", label: "Din roadmap", detail: "Din roadmap · v3" },
      { kind: "chat" as const, id: "c1", label: "Review status", detail: "Chat" },
    ];
    const opened: string[] = [];
    const render = (pane: AnyPane, ctx: { visible: boolean; focused: boolean; active: boolean }) =>
      pane.kind === "door"
        ? <DoorPane ctx={ctx} draftKey={pane.data.draftKey} recents={recents} onWake={() => store.dispatch({ type: "focusPane", paneId: pane.id })} onOpenRecent={(r) => opened.push(r.id)} />
        : <div data-plan-body="" />;
    await act(async () => {
      store.dispatch({ type: "splitPane", paneId: "p1", direction: "row", pane: { kind: "plan", data: { sessionId: "s1", version: null } }, newPaneId: "pl", before: true });
    });
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={render} onNewTab={() => {}} />));
    // The plan has the focus (a click there, as on screen).
    await act(async () => store.dispatch({ type: "focusPane", paneId: "pl" }));
    const door = () => host.querySelector<HTMLElement>('.rl-wb-tab-body:not([data-hidden]) .rl-wb-pane[data-pane-id="p1"]')!;
    for (let i = 0; i < 20 && !door().querySelector("[data-door-rest]"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(door().querySelector("[data-rl-door-plate]")).toBeNull();
    expect(door().querySelector(".rl-door-rest-box")?.textContent).toBe("What are we working on?");
    expect([...door().querySelectorAll(".rl-door-rest-chip")].map((c) => c.textContent)).toEqual(["Din roadmap", "Review status"]);
    await act(async () => door().querySelector<HTMLButtonElement>(".rl-door-rest-chip")!.click());
    expect(opened).toEqual(["s1"]);
    // A press in the box wakes the door: it takes the focus and the plate
    // the island lands on.
    await act(async () => store.dispatch({ type: "focusPane", paneId: "pl" }));
    await act(async () => door().querySelector<HTMLButtonElement>(".rl-door-rest-box")!.click());
    expect(store.getState().sets.home!.tabs.t1.focusedPaneId).toBe("p1");
    expect(door().querySelector("[data-rl-door-plate]")).not.toBeNull();
    expect(door().querySelector("[data-door-rest]")).toBeNull();
  });
});

// D40: a split never draws a pane below its kind's minimum — each cell
// carries it as `min-width`, which flex honours over the weight — and a
// divider dragged toward a pane stops at its minimum.
describe("pane minimums in a split (D40)", () => {
  const pointer = (type: string, x = 0) => {
    const ev = new MouseEvent(type, { bubbles: true, clientX: x }) as MouseEvent & { pointerId: number };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    return ev;
  };
  /** The door p1 beside a plan, laid out across a stage `stage` px wide. */
  const planBesideDoor = async (stage: number) => {
    await act(async () => store.dispatch({ type: "splitPane", paneId: "p1", direction: "row", pane: { kind: "plan", data: { sessionId: "s1", version: null } }, newPaneId: "pl", before: true }));
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={renderPane} onNewTab={() => {}} />));
    const split = host.querySelector<HTMLElement>(".rl-wb-tab-body:not([data-hidden]) .rl-wb-split")!;
    const [a, b] = [...split.children].filter((c): c is HTMLElement => c.classList.contains("rl-wb-split-cell"));
    const half = (stage - 1) / 2;
    const rect = (left: number, width: number) => ({ left, top: 0, right: left + width, bottom: 600, width, height: 600, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    a.getBoundingClientRect = () => rect(0, half);
    b.getBoundingClientRect = () => rect(half + 1, half);
    const divider = split.querySelector<HTMLElement>(".rl-split-divider")!;
    const share = () => {
      const st = store.getState();
      const node = st.sets[st.activeKey]!.tabs.t1.root;
      return "split" in node ? node.weights[0] : null;
    };
    return { a, b, divider, share };
  };

  it("each cell carries its pane's minimum, and the seam is one rule", async () => {
    const { a, b, divider } = await planBesideDoor(1440);
    // Never a proportional squeeze: a window too narrow for the split zooms
    // its focused pane instead (the reducer's `fitStage`).
    expect(a.style.minWidth).toBe(`${PANE_MIN_W.plan}px`);
    expect(b.style.minWidth).toBe(`${DOOR_MIN_W}px`);
    expect(divider.style.flex).toBe("0 0 1px");
  });

  it("on a 1440 stage a drag toward the plan stops at the plan's minimum", async () => {
    const { divider, share } = await planBesideDoor(1440);
    await act(async () => { divider.dispatchEvent(pointer("pointerdown", 720)); });
    await act(async () => { window.dispatchEvent(pointer("pointermove", 40)); });
    await act(async () => { window.dispatchEvent(pointer("pointerup")); });
    expect(share()).toBeCloseTo(PANE_MIN_W.plan / 1439, 2);
  });

  it("on a 1440 stage a drag toward the door stops at the door's minimum", async () => {
    const { divider, share } = await planBesideDoor(1440);
    await act(async () => { divider.dispatchEvent(pointer("pointerdown", 720)); });
    await act(async () => { window.dispatchEvent(pointer("pointermove", 1400)); });
    await act(async () => { window.dispatchEvent(pointer("pointerup")); });
    expect(share()).toBeCloseTo(1 - DOOR_MIN_W / 1439, 2);
  });

  it("on a 900 stage, where the pair is already at its floors, a drag moves nothing", async () => {
    const { divider, share } = await planBesideDoor(900);
    await act(async () => { divider.dispatchEvent(pointer("pointerdown", 450)); });
    await act(async () => { window.dispatchEvent(pointer("pointermove", 100)); });
    await act(async () => { window.dispatchEvent(pointer("pointerup")); });
    expect(share()).toBeCloseTo(0.5, 5);
  });
});
