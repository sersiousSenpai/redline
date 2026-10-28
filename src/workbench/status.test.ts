// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { deriveTermState, loudOldestFirst, nextNeedsYou, needsYouState, type TermSignals, type TermState } from "../lib/termState";
import { asksRetired } from "../lib/openAsks";
import { needsYouTerminals, paneStatusOf, terminalStatus, wallStatus, worstStatus } from "./status";

describe("paneStatusOf", () => {
  it("folds the terminal's eight states into four", () => {
    expect(paneStatusOf("needs-you")).toBe("needs");
    // A finished turn waits on nobody (the last walk).
    expect(paneStatusOf("your-turn")).toBe("idle");
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

// The last walk: a row at NEEDS YOU under a top bar at 0, a question's row
// flipping to WORKING seconds after leaving it, ⌘⇧J landing on a finished
// build. One table: each state's signals, derived once, read by every
// surface the same way.
describe("one needs-you set: the row, the dot, the top bar's count and ⌘⇧J agree in every state", () => {
  const base: TermSignals = { attention: null, seen: false, held: false, exited: false, fgComm: "2.1.312", fgIsShell: false, ports: [], placeholder: false };
  const cases: [name: string, signals: Partial<TermSignals>, state: TermState, needs: boolean][] = [
    // An AskUserQuestion held by its hook fires no Notification: its hooks
    // still say working, and the open card is what says needs you.
    ["question open (a card, hooks say working)", { attention: "working", asking: true }, "needs-you", true],
    ["question released to the terminal (its dialog, published by the pane)", { attention: "working", asking: true }, "needs-you", true],
    ["permission open (its Notification)", { attention: "needs-you" }, "needs-you", true],
    ["held plan (blocked in the review hook since its prompt)", { attention: "working", held: true }, "held", true],
    ["building", { attention: "working" }, "working", false],
    ["finished (Stop, unread)", { attention: "your-turn", seen: false }, "your-turn", false],
    ["finished and read", { attention: "your-turn", seen: true }, "idle", false],
    ["exited (the PTY is gone)", { attention: "needs-you", exited: true }, "exited", false],
    ["killed (shell back in front, last hook the idle reminder)", { attention: null, fgComm: "zsh", fgIsShell: true, agentLeft: true }, "exited", false],
    ["killed mid-permission (the stale-sample ack)", { attention: null, fgComm: "zsh", fgIsShell: true, agentGone: true }, "exited", false],
  ];

  it.each(cases)("%s", (_name, signals, state, needs) => {
    const derived = deriveTermState({ ...base, ...signals });
    expect(derived).toBe(state);
    const states = new Map([["t", { state: derived }]]);
    // The row and the tab dot.
    expect(terminalStatus("t", { states }) === "needs").toBe(needs);
    expect(paneStatusOf(derived) === "needs").toBe(needs);
    expect(needsYouState(derived)).toBe(needs);
    // The top bar's count and ⌘⇧J's list.
    expect(needsYouTerminals(["t"], { states, live: ["t"] })).toEqual(needs ? ["t"] : []);
    expect(loudOldestFirst(["t"], new Map([["t", derived]]), new Map())).toEqual(needs ? ["t"] : []);
  });

  it("⌘⇧J walks only what needs you, never a finished build, oldest first", () => {
    const states = new Map<string, TermState>([["done", "your-turn"], ["ask", "needs-you"], ["plan", "held"], ["build", "working"], ["dead", "exited"]]);
    const at = (id: string, ms: number) => [id, { terminalId: id, sessionId: "s", at: ms, kind: "working" }] as const;
    const attention = new Map([at("done", 1), at("ask", 3), at("plan", 2), at("build", 4), at("dead", 0)]);
    const walk = loudOldestFirst([...states.keys()], states, attention as never);
    expect(walk).toEqual(["plan", "ask"]);
    expect(nextNeedsYou(walk, new Map([["plan", 10]]))).toBe("ask");
  });

  it("before the wall reports, the hooks say the same: a your-turn is not a need, a gone terminal never is", () => {
    const states = new Map<string, { state: TermState }>();
    const attention = new Map([["a", "your-turn"], ["b", "needs-you"], ["c", "working"], ["d", "needs-you"]]);
    expect(needsYouTerminals(["a", "b", "c", "d", "h"], { states, attention, held: new Set(["h"]), live: ["a", "b", "c", "h"] })).toEqual(["b", "h"]);
  });

  it("an open question outlives its pane until the terminal moves past it", () => {
    const open = new Map([["q", 100], ["r", 100], ["s", 100], ["t", 100]]);
    const attention = new Map([
      ["q", { at: 50, kind: "working" }], // the hook from before the card: still open
      ["r", { at: 150, kind: "needs-you" }], // the TUI's own card notifying: still open
      ["s", { at: 150, kind: "your-turn" }], // the turn ended: past it
    ]);
    expect(asksRetired(open, attention, (id) => id === "t")).toEqual(["s", "t"]);
  });
});
