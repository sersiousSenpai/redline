// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
