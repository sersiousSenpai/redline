// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { arrivalFocus, arrivalMessage, type ArrivalState } from "./planArrival";

const at = (over: Partial<ArrivalState>): ArrivalState => ({
  activeId: null,
  sessionId: "B",
  mainSurface: "document",
  plateMode: "door",
  ...over,
});

describe("arrivalFocus", () => {
  it("focuses from the Front Door — the plate becomes the plan", () => {
    expect(arrivalFocus(at({}))).toBe("focus");
  });

  it("flashes while you are reading another plan", () => {
    expect(arrivalFocus(at({ activeId: "A", plateMode: "plan" }))).toBe("flash");
  });

  it("focuses when the same session's plan re-arrives — it's the answer you waited for", () => {
    expect(arrivalFocus(at({ activeId: "B", plateMode: "plan" }))).toBe("focus");
  });

  it("focuses the selection on a masked surface (the caller leaves the surface alone)", () => {
    for (const mainSurface of ["browser", "memory", "runs"] as const) {
      expect(arrivalFocus(at({ activeId: "A", plateMode: "plan", mainSurface }))).toBe("focus");
    }
  });

  it("focuses when a file, not a plan, is on the plate", () => {
    expect(arrivalFocus(at({ activeId: "A", plateMode: "file" }))).toBe("focus");
  });
});

describe("arrivalMessage", () => {
  it("names the plan and never says intercepted", () => {
    expect(arrivalMessage("Auth rewrite")).toBe("New plan · Auth rewrite");
    expect(arrivalMessage(null)).toBe("New plan");
    expect(arrivalMessage("  ")).toBe("New plan");
  });
});
