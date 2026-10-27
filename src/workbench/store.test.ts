// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";

import { emptyWorkbench } from "./model";
import { createWorkbenchStore } from "./store";

describe("workbench store", () => {
  it("notifies on a change, keeps the same object for a no-op, and unsubscribes", () => {
    const store = createWorkbenchStore(emptyWorkbench());
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
