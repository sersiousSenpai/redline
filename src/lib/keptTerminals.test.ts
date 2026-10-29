// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { adoptKept, parseKeptMeta, type LivePty } from "./terminalWorkspace";
import { heldLine, quitAsk, quitTitle } from "./quitFlow";
import { adoptedBinds, resetKeptMeta, syncKeptMeta } from "./keptMeta";
import { markAdopted, pendingAttaches, scheduleAttach } from "./attachStagger";

const kept = (id: string, over: Partial<LivePty> = {}): LivePty => ({ id, cwd: "/repo", pid: 1, alive: true, kept: true, persist: true, ...over });

describe("adopting what the helper kept", () => {
  it("makes live kept terminals tabs again, oldest first, named from meta; nothing else", () => {
    const list = [
      kept("b", { startedAt: 20, meta: { title: "web", owner: "plan:x" } }),
      kept("a", { startedAt: 10 }),
      kept("dead", { alive: false, exit: 256 }),
      { id: "local", cwd: null, pid: 2, alive: true },
      kept("mine", { startedAt: 1 }),
    ];
    expect(adoptKept(list, new Set(["mine"]))).toEqual([{ id: "a", cwd: "/repo" }, { id: "b", cwd: "/repo", title: "web" }]);
  });

  it("reads meta as untrusted", () => {
    expect(parseKeptMeta(null)).toBeNull();
    expect(parseKeptMeta([1])).toBeNull();
    expect(parseKeptMeta({ owner: 3, title: "" })).toBeNull();
    expect(parseKeptMeta({ title: "x".repeat(200), harness: "codex", junk: true })).toEqual({ title: "x".repeat(80), harness: "codex" });
    expect(parseKeptMeta({ harness: "vim" })).toBeNull();
  });

  it("seeds each adopted terminal's session", () => {
    expect(adoptedBinds([kept("t1", { meta: { sessionId: "s1" } }), kept("t2"), kept("t3", { alive: false, meta: { sessionId: "s3" } })])).toEqual([{ sessionId: "s1", terminalId: "t1" }]);
  });
});

describe("placement goes to the helper only when it changes", () => {
  afterEach(() => resetKeptMeta());
  it("writes each terminal's meta once per change", () => {
    const write = vi.fn(async () => {});
    expect(syncKeptMeta([{ id: "t", meta: { owner: "home", title: "zsh" } }], write)).toBe(1);
    expect(syncKeptMeta([{ id: "t", meta: { owner: "home", title: "zsh" } }], write)).toBe(0);
    expect(syncKeptMeta([{ id: "t", meta: { owner: "plan:p", title: "zsh" } }], write)).toBe(1);
    expect(write).toHaveBeenLastCalledWith("t", { owner: "plan:p", title: "zsh" });
    // A terminal that went and came back under the same id is written again.
    syncKeptMeta([], write);
    expect(syncKeptMeta([{ id: "t", meta: { owner: "plan:p", title: "zsh" } }], write)).toBe(1);
  });
});

describe("what a quit says", () => {
  const on = { helperActive: true, keepOnQuit: true, askOnQuit: true };
  it("asks with terminals running, says a held plan always, and is silent otherwise", () => {
    const list = [kept("a"), kept("b"), kept("c", { persist: false }), kept("d", { alive: false })];
    expect(quitAsk(on, list, [])).toEqual({ keeping: 2, ending: 1, held: [] });
    expect(quitAsk({ ...on, askOnQuit: false }, list, [])).toBeNull();
    expect(quitAsk({ ...on, askOnQuit: false }, list, ["Plan A"])).toEqual({ keeping: 2, ending: 1, held: ["Plan A"] });
    expect(quitAsk(on, [], [])).toBeNull();
    expect(quitAsk({ ...on, keepOnQuit: false }, list, ["Plan A"]), "nothing is kept: a quit is what it always was").toBeNull();
    expect(quitAsk({ ...on, helperActive: false }, list, [])).toBeNull();
  });

  it("names what happens", () => {
    expect(quitTitle({ keeping: 1, ending: 0, held: [] })).toBe("A terminal keeps running after Redline quits");
    expect(quitTitle({ keeping: 3, ending: 0, held: [] })).toBe("3 terminals keep running after Redline quits");
    expect(quitTitle({ keeping: 0, ending: 0, held: ["x"] })).toBe("A plan is waiting for your review");
    expect(heldLine("Ports chip")).toBe("Ports chip is waiting for your review. If you quit, its terminal asks in the terminal instead.");
  });

  it("speaks Redline's palette: no red in the dialog", () => {
    const source = readFileSync("src/components/QuitDialog.tsx", "utf8");
    expect(source).not.toMatch(/--color-(danger|error|red)|#e8553d|\bred\b/i);
  });
});

describe("a relaunch's hidden terminals attach one per idle frame", () => {
  it("staggers only the just-adopted hidden ones", async () => {
    const ran: string[] = [];
    scheduleAttach("plain", false, () => ran.push("plain"));
    expect(ran, "a terminal that wasn't adopted attaches at once").toEqual(["plain"]);
    markAdopted(["shown", "h1", "h2"]);
    scheduleAttach("shown", true, () => ran.push("shown"));
    scheduleAttach("h1", false, () => ran.push("h1"));
    scheduleAttach("h2", false, () => ran.push("h2"));
    expect(ran).toEqual(["plain", "shown"]);
    expect(pendingAttaches()).toBe(2);
    await vi.waitFor(() => expect(ran).toEqual(["plain", "shown", "h1", "h2"]));
    scheduleAttach("h1", false, () => ran.push("again"));
    expect(ran[ran.length - 1], "adoption is used up by the first attach").toBe("again");
  });
});

import { agentLiveness } from "./stillRunning";

describe("is a kept session's CLI still running?", () => {
  it("only with the agent in front of a live terminal; the shell in front is a CLI that exited; unknown is neither", () => {
    expect(agentLiveness("t-agent", null, true, "claude 2")).toEqual({ state: "checking" });
    expect(agentLiveness("t-agent", ["t-agent"], true, "claude 2")).toEqual({ state: "running", label: "claude 2" });
    expect(agentLiveness("t-shell", ["t-shell"], false, "zsh"), "exited CLI: Restore as before").toBeNull();
    expect(agentLiveness("t-new", ["t-new"], undefined, undefined), "not sampled yet").toEqual({ state: "checking" });
    expect(agentLiveness("t-agent", [], true, "claude 2"), "terminal gone: Restore").toBeNull();
    expect(agentLiveness(undefined, ["x"], undefined, undefined)).toBeNull();
  });
});
