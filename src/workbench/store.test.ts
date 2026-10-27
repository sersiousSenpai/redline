// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";

import { emptyWorkbench } from "./model";
import { reduce } from "./reducer";
import { createWorkbenchStore } from "./store";

describe("workbench store", () => {
  it("notifies on a change, keeps the same object for a no-op, and unsubscribes", () => {
    const store = createWorkbenchStore(emptyWorkbench(), reduce);
    const before = store.getState();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.dispatch({ type: "selectTab", tabId: "nope" });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState()).toBe(before);
    store.dispatch({ type: "openTab", pane: { kind: "memory", data: {} }, tabId: "m" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().sets.home!.order).toEqual(["m"]);
    store.replace(store.getState());
    expect(listener).toHaveBeenCalledTimes(1);
    store.replace(emptyWorkbench());
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.dispatch({ type: "openTab", pane: { kind: "runs", data: {} } });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("a lazily loaded reducer", () => {
  it("queues the actions dispatched before it lands, applies them in order, and notifies once", async () => {
    let resolve!: (fn: typeof reduce) => void;
    const load = () => new Promise<typeof reduce>((r) => { resolve = r; });
    const store = createWorkbenchStore(emptyWorkbench(), load);
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: "openTab", pane: { kind: "memory", data: {} }, tabId: "m" });
    store.dispatch({ type: "openTab", pane: { kind: "runs", data: {} }, tabId: "r" });
    expect(store.getState().sets.home!.order).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    resolve(reduce);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().sets.home!.order).toEqual(["m", "r"]);
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "selectTab", tabId: "m" });
    expect(store.getState().sets.home!.activeTabId).toBe("m");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
