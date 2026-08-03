// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { resolveReorder } from "./TerminalTabBar";

describe("resolveReorder", () => {
  const ids = ["a", "b", "c", "d"];

  it("resolves the drag by id against the current order", () => {
    expect(resolveReorder(ids, "b", 3)).toEqual({ from: 1, to: 3 });
    expect(resolveReorder(ids, "d", 0)).toEqual({ from: 3, to: 0 });
  });

  it("no-ops when the dragged tab already rests at the target", () => {
    expect(resolveReorder(ids, "c", 2)).toBeNull();
  });

  it("no-ops when the dragged tab vanished mid-drag", () => {
    // The shell exited and its tab closed while the pointer was down — a
    // commit against the captured start index would move (or kill) the
    // wrong tab's session.
    expect(resolveReorder(["a", "c", "d"], "b", 2)).toBeNull();
  });

  it("recomputes from when tabs shifted under the drag", () => {
    // "c" was grabbed at index 2, but a tab before it closed mid-drag: its
    // CURRENT index (1) must be used, never the stale one.
    expect(resolveReorder(["a", "c", "d"], "c", 0)).toEqual({ from: 1, to: 0 });
  });

  it("clamps an out-of-range target into the current list", () => {
    // The list shrank after the target was computed.
    expect(resolveReorder(["a", "b"], "a", 5)).toEqual({ from: 0, to: 1 });
    expect(resolveReorder(["a", "b"], "b", -2)).toEqual({ from: 1, to: 0 });
  });

  it("handles a single remaining tab", () => {
    expect(resolveReorder(["a"], "a", 3)).toBeNull();
  });
});
