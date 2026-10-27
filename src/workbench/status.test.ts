// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { paneStatusOf, worstStatus } from "./status";

describe("paneStatusOf", () => {
  it("folds the terminal's eight states into four", () => {
    expect(paneStatusOf("needs-you")).toBe("needs");
    expect(paneStatusOf("your-turn")).toBe("needs");
    expect(paneStatusOf("held")).toBe("needs");
    expect(paneStatusOf("working")).toBe("working");
    expect(paneStatusOf("running")).toBe("working");
    expect(paneStatusOf("serving")).toBe("working");
    expect(paneStatusOf("exited")).toBe("exited");
    expect(paneStatusOf("idle")).toBe("idle");
    expect(paneStatusOf(null)).toBe("idle");
    expect(paneStatusOf(undefined)).toBe("idle");
  });
});

describe("worstStatus", () => {
  it("needs you outranks working outranks idle", () => {
    expect(worstStatus(["idle", "working", "needs"])).toBe("needs");
    expect(worstStatus(["idle", "working"])).toBe("working");
    expect(worstStatus(["idle", "idle"])).toBe("idle");
  });
  it("exited only when everything exited", () => {
    expect(worstStatus(["exited", "exited"])).toBe("exited");
    expect(worstStatus(["exited", "idle"])).toBe("idle");
    expect(worstStatus([])).toBe("idle");
  });
});
