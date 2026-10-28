// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyWorkbench, type AnyPane } from "./model";
import { reduce } from "./reducer";
import { createWorkbenchStore, type WorkbenchStore } from "./store";
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
