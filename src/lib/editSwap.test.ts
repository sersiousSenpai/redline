// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  initialEditSwap,
  reduceEditSwap,
  type EditSwapState,
} from "./editSwap";

const view: EditSwapState<string> = { mode: "view", error: null };

describe("reduceEditSwap", () => {
  it("edit → preparing, and a matching prepared → editing", () => {
    const preparing = reduceEditSwap<string>(view, { type: "edit", seq: 1 });
    expect(preparing).toEqual({ mode: "preparing", seq: 1 });
    expect(
      reduceEditSwap(preparing, { type: "prepared", seq: 1, payload: "p" }),
    ).toEqual({ mode: "editing", payload: "p" });
  });

  it("drops a stale prepared (seq from an abandoned attempt)", () => {
    const preparing = reduceEditSwap<string>(view, { type: "edit", seq: 2 });
    expect(
      reduceEditSwap(preparing, { type: "prepared", seq: 1, payload: "old" }),
    ).toBe(preparing);
  });

  it("prepare-failed returns to view carrying the error", () => {
    const preparing = reduceEditSwap<string>(view, { type: "edit", seq: 1 });
    expect(
      reduceEditSwap(preparing, {
        type: "prepare-failed",
        seq: 1,
        error: "boom",
      }),
    ).toEqual({ mode: "view", error: "boom" });
  });

  it("stale prepare-failed is ignored too", () => {
    const preparing = reduceEditSwap<string>(view, { type: "edit", seq: 3 });
    expect(
      reduceEditSwap(preparing, { type: "prepare-failed", seq: 2, error: "x" }),
    ).toBe(preparing);
  });

  it("path-changed mid-prepare forces view; a late prepared stays dropped", () => {
    const preparing = reduceEditSwap<string>(view, { type: "edit", seq: 1 });
    const back = reduceEditSwap(preparing, { type: "path-changed" });
    expect(back).toEqual({ mode: "view", error: null });
    // The in-flight resolve for the old file lands afterwards — no-op.
    expect(
      reduceEditSwap(back, { type: "prepared", seq: 1, payload: "stale" }),
    ).toBe(back);
  });

  it("edit while already preparing or editing is a no-op", () => {
    const preparing = reduceEditSwap<string>(view, { type: "edit", seq: 1 });
    expect(reduceEditSwap(preparing, { type: "edit", seq: 9 })).toBe(preparing);
    const editing = reduceEditSwap(preparing, {
      type: "prepared",
      seq: 1,
      payload: "p",
    });
    expect(reduceEditSwap(editing, { type: "edit", seq: 9 })).toBe(editing);
  });

  it("done leaves editing back to a clean view", () => {
    const editing: EditSwapState<string> = { mode: "editing", payload: "p" };
    expect(reduceEditSwap(editing, { type: "done" })).toEqual({
      mode: "view",
      error: null,
    });
  });

  it("initial state is a clean view", () => {
    expect(initialEditSwap).toEqual({ mode: "view", error: null });
  });
});
