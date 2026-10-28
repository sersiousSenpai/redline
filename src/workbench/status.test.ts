// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { paneStatusOf, terminalStatus, wallStatus, worstStatus } from "./status";

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

  it("a wall's dot is the worst of its tiles: needs you over working; all exited is muted; idle says nothing", () => {
    const states = new Map([["a", { state: "idle" as const }], ["b", { state: "working" as const }], ["c", { state: "needs-you" as const }], ["d", { state: "exited" as const }]]);
    expect(wallStatus(["a", "b"], states)).toBe("working");
    expect(wallStatus(["a", "b", "c"], states)).toBe("needs");
    expect(wallStatus(["d"], states)).toBe("exited");
    expect(wallStatus(["a"], states)).toBeUndefined();
    expect(wallStatus(["nope"], states)).toBeUndefined();
  });
});

describe("terminalStatus", () => {
  const states = new Map([["walled", { state: "idle" as const }]]);
  it("reads the wall's derivation first, so a row and a tab dot never disagree", () => {
    expect(terminalStatus("walled", { states, attention: new Map([["walled", "working"]]) })).toBe("idle");
  });
  it("reads a held plan as needing you, never as the hook's stale working", () => {
    expect(terminalStatus("t", { states, attention: new Map([["t", "working"]]), held: new Set(["t"]) })).toBe("needs");
  });
  it("falls back to the hooks the daemon re-read on boot", () => {
    expect(terminalStatus("a", { states, attention: new Map([["a", "needs-you"]]) })).toBe("needs");
    expect(terminalStatus("b", { states, attention: new Map([["b", "working"]]) })).toBe("working");
    expect(terminalStatus("c", { states, attention: new Map([["c", "idle"]]) })).toBe("idle");
    expect(terminalStatus("d", { states })).toBe("idle");
  });
  it("calls a terminal missing from the live list exited", () => {
    expect(terminalStatus("walled", { states, live: ["other"] })).toBe("exited");
  });
});
