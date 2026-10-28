// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { TermAttention, TermProc } from "../types";
import {
  ackForInput,
  attentionText,
  deriveTermState,
  effectiveAttention,
  isAgentComm,
  isLoud,
  isQuiet,
  loudOldestFirst,
  mergeAttention,
  mergeProcs,
  nextNeedsYou,
  putAck,
  staleAcks,
  agentGone,
  agentLeft,
  agentPresence,
  type AttentionAck,
  type TermSignals,
  type TermState,
} from "./termState";

const quiet: TermSignals = {
  attention: null,
  seen: false,
  held: false,
  exited: false,
  fgComm: null,
  fgIsShell: false,
  ports: [],
  placeholder: false,
};
const derive = (extra: Partial<TermSignals>) => deriveTermState({ ...quiet, ...extra });

const needs = (id: string, at: number, message: string | null = "Claude needs your permission"): TermAttention =>
  ({ terminalId: id, sessionId: "s", at, kind: "needs-you", reason: "permission_prompt", message });
const turn = (id: string, at: number, excerpt: string | null = "Which key?"): TermAttention =>
  ({ terminalId: id, sessionId: "s", at, kind: "your-turn", excerpt });
const working = (id: string, at: number): TermAttention =>
  ({ terminalId: id, sessionId: "s", at, kind: "working" });
const proc = (id: string, extra: Partial<TermProc> = {}): TermProc =>
  ({ id, fgComm: "zsh", fgIsShell: true, ports: [], ...extra });

describe("deriveTermState", () => {
  it("picks each state from its own signal", () => {
    expect(derive({})).toBe("idle");
    expect(derive({ attention: "needs-you" })).toBe("needs-you");
    expect(derive({ attention: "your-turn" })).toBe("your-turn");
    expect(derive({ held: true })).toBe("held");
    expect(derive({ attention: "working" })).toBe("working");
    expect(derive({ ports: [5173] })).toBe("serving");
    expect(derive({ fgComm: "vim" })).toBe("running");
    expect(derive({ exited: true })).toBe("exited");
  });

  it("orders them needs-you › your-turn › held › working › serving › running › idle", () => {
    const all: Partial<TermSignals> = { held: true, ports: [3000], fgComm: "node" };
    expect(derive({ ...all, attention: "needs-you" })).toBe("needs-you");
    expect(derive({ ...all, attention: "your-turn" })).toBe("your-turn");
    expect(derive({ ...all, attention: "working" })).toBe("held");
    expect(derive({ ports: [3000], fgComm: "node", attention: "working" })).toBe("working");
    expect(derive({ ports: [3000], fgComm: "node" })).toBe("serving");
  });

  it("puts exited FIRST — a dead PTY cannot need anything, whatever its last hook said", () => {
    expect(derive({ exited: true, attention: "needs-you", held: true, ports: [1] })).toBe("exited");
  });

  it("a read your-turn falls through to what is underneath", () => {
    expect(derive({ attention: "your-turn", seen: true })).toBe("idle");
    expect(derive({ attention: "your-turn", seen: true, held: true })).toBe("held");
    expect(derive({ attention: "your-turn", seen: true, ports: [8080] })).toBe("serving");
  });

  it("an agent in the foreground is not 'running', and a shell never is", () => {
    expect(derive({ fgComm: "claude" })).toBe("idle");
    expect(derive({ fgComm: "codex" })).toBe("idle");
    expect(derive({ fgComm: "zsh", fgIsShell: true })).toBe("idle");
    // An npm-installed CLI runs as node; once it has spoken through the hooks
    // it is an agent, before that just a node program.
    expect(derive({ fgComm: "node", attention: "idle" })).toBe("idle");
    expect(derive({ fgComm: "node" })).toBe("running");
  });

  it("an untouched placeholder is idle even before its shell settles", () => {
    expect(derive({ placeholder: true, fgComm: "login" })).toBe("idle");
    expect(derive({ placeholder: true, exited: true })).toBe("exited");
  });

  it("isAgentComm is case-insensitive and needs a name", () => {
    expect(isAgentComm("Claude", false)).toBe(true);
    expect(isAgentComm(null, true)).toBe(false);
    expect(isAgentComm("node", true)).toBe(true);
    expect(isAgentComm("node", false)).toBe(false);
    // Claude Code's native build runs as the file its `claude` link resolves
    // to, named for its version: an agent, at its prompt idle, not a job.
    expect(isAgentComm("2.1.312", false)).toBe(true);
    expect(deriveTermState({ attention: null, seen: false, held: false, exited: false, fgComm: "2.1.312", fgIsShell: false, ports: [], placeholder: false })).toBe("idle");
  });
});

describe("isLoud / isQuiet", () => {
  it("partitions the states: loud, busy, quiet", () => {
    const states: TermState[] = ["needs-you", "your-turn", "working", "running", "serving", "held", "idle", "exited"];
    expect(states.filter(isLoud)).toEqual(["needs-you", "your-turn"]);
    expect(states.filter(isQuiet)).toEqual(["serving", "held", "idle", "exited"]);
  });
});

describe("clearing rules", () => {
  it("typing into a needs-you answers it: the terminal goes back to working", () => {
    const entry = needs("a", 10);
    const ack = ackForInput(entry, undefined, false);
    expect(ack).toEqual({ at: 10, as: "working" });
    expect(effectiveAttention(entry, ack!)).toEqual({ kind: "working", seen: false });
    // Further keystrokes change nothing (no render per key).
    expect(ackForInput(entry, ack!, false)).toBeNull();
  });

  it("Esc or Ctrl-C interrupts: working and needs-you are cleared, since no hook will say so", () => {
    expect(ackForInput(working("a", 5), undefined, true)).toEqual({ at: 5, as: "cleared" });
    expect(ackForInput(needs("a", 6), undefined, true)).toEqual({ at: 6, as: "cleared" });
    // An answered needs-you is working; interrupting it clears it too.
    expect(ackForInput(needs("a", 6), { at: 6, as: "working" }, true)).toEqual({ at: 6, as: "cleared" });
    expect(effectiveAttention(working("a", 5), { at: 5, as: "cleared" })).toEqual({ kind: null, seen: false });
  });

  it("any keystroke reads a your-turn", () => {
    const entry = turn("a", 7);
    expect(ackForInput(entry, undefined, false)).toEqual({ at: 7, as: "seen" });
    expect(ackForInput(entry, undefined, true)).toEqual({ at: 7, as: "seen" });
    expect(ackForInput(entry, { at: 7, as: "seen" }, false)).toBeNull();
    expect(effectiveAttention(entry, { at: 7, as: "seen" })).toEqual({ kind: "your-turn", seen: true });
  });

  it("an acknowledgement never swallows a NEW transition, even of the same kind", () => {
    const ack: AttentionAck = { at: 10, as: "working" };
    expect(effectiveAttention(needs("a", 11), ack)).toEqual({ kind: "needs-you", seen: false });
    expect(effectiveAttention(turn("a", 12), { at: 7, as: "seen" })).toEqual({ kind: "your-turn", seen: false });
  });

  it("input with no attention, or into a working agent, acknowledges nothing", () => {
    expect(ackForInput(undefined, undefined, false)).toBeNull();
    expect(ackForInput(working("a", 1), undefined, false)).toBeNull();
    expect(effectiveAttention(undefined, undefined)).toEqual({ kind: null, seen: false });
  });

  it("a process sample showing the shell back in front retires an OLDER working or needs-you only", () => {
    const attention = new Map([
      ["gone", working("gone", 100)],
      ["blocked", needs("blocked", 100)],
      ["answered", needs("answered", 100)],
      ["fresh", needs("fresh", 205)],
      ["busy", working("busy", 100)],
      ["cleared", working("cleared", 100)],
      // A one-shot run (`claude -p`) exits right after its Stop: its answer
      // is still waiting to be read.
      ["one-shot", turn("one-shot", 100)],
    ]);
    const acks = new Map<string, AttentionAck>([
      ["answered", { at: 100, as: "working" }],
      ["cleared", { at: 100, as: "cleared" }],
    ]);
    const rows = [
      proc("gone"),
      proc("blocked"),
      proc("answered"),
      // The hook fired after the sample was requested: the sample can't know.
      proc("fresh"),
      // The agent is still in front.
      proc("busy", { fgComm: "claude", fgIsShell: false }),
      proc("cleared"),
      proc("one-shot"),
      proc("unknown"),
    ];
    expect(staleAcks(attention, acks, rows, 200)).toEqual([
      ["gone", { at: 100, as: "gone" }],
      ["blocked", { at: 100, as: "gone" }],
      ["answered", { at: 100, as: "gone" }],
    ]);
  });

  it("a dead agent's terminal reads exited, never a stale needs-you (the re-walk)", () => {
    const entry = needs("t", 100);
    const ack: AttentionAck = { at: 100, as: "gone" };
    expect(agentGone(entry, ack)).toBe(true);
    expect(agentGone(needs("t", 101), ack)).toBe(false);
    const base = { seen: false, held: false, exited: false, fgComm: "zsh", fgIsShell: true, ports: [], placeholder: false };
    expect(deriveTermState({ ...base, attention: effectiveAttention(entry, ack).kind, agentGone: true })).toBe("exited");
    // An agent started in it again is a new life: the shell is no longer in front.
    expect(deriveTermState({ ...base, attention: null, agentGone: true, fgComm: "claude", fgIsShell: false })).toBe("idle");
  });

  it("an open card (a held AskUserQuestion) needs you, as a permission does", () => {
    const base = { seen: false, held: false, exited: false, fgComm: "claude", fgIsShell: false, ports: [], placeholder: false };
    expect(deriveTermState({ ...base, attention: "working", asking: true })).toBe("needs-you");
    expect(deriveTermState({ ...base, attention: "working" })).toBe("working");
    expect(deriveTermState({ ...base, attention: "working", asking: true, exited: true })).toBe("exited");
  });
});

describe("mergeAttention", () => {
  it("keeps the latest transition per terminal and drops stragglers", () => {
    const one = mergeAttention(new Map(), [working("a", 1), needs("b", 2)]);
    const two = mergeAttention(one, [turn("a", 3), working("b", 1)]);
    expect(two.get("a")?.kind).toBe("your-turn");
    expect(two.get("b")?.kind).toBe("needs-you");
  });

  it("the same `at` is the same transition filling in its excerpt", () => {
    const first = mergeAttention(new Map(), [turn("a", 5, null)]);
    const filled = mergeAttention(first, [turn("a", 5, "Paste the API key here")]);
    expect(attentionText(filled.get("a"))).toBe("Paste the API key here");
  });

  it("returns the SAME map for a no-op so an unchanged event costs no render", () => {
    const prev = mergeAttention(new Map(), [needs("a", 5)]);
    expect(mergeAttention(prev, [needs("a", 5)])).toBe(prev);
    expect(mergeAttention(prev, [working("a", 4)])).toBe(prev);
    expect(mergeAttention(prev, [])).toBe(prev);
  });

  it("names what a loud transition said, and nothing for a quiet one", () => {
    expect(attentionText(needs("a", 1, "Claude needs your permission"))).toBe("Claude needs your permission");
    expect(attentionText(turn("a", 1, "Done."))).toBe("Done.");
    expect(attentionText(working("a", 1))).toBeNull();
    expect(attentionText(undefined)).toBeNull();
  });
});

describe("putAck / mergeProcs", () => {
  it("putAck keeps identity when the acknowledgement is already there", () => {
    const prev = putAck(new Map(), "a", { at: 1, as: "seen" });
    expect(putAck(prev, "a", { at: 1, as: "seen" })).toBe(prev);
    expect(putAck(prev, "a", { at: 2, as: "seen" }).get("a")).toEqual({ at: 2, as: "seen" });
  });

  it("mergeProcs keeps identity for an unchanged fleet and replaces it on any move", () => {
    const prev = mergeProcs(new Map(), [proc("a"), proc("b", { fgComm: "node", fgIsShell: false, ports: [5173] })]);
    expect(mergeProcs(prev, [proc("a"), proc("b", { fgComm: "node", fgIsShell: false, ports: [5173] })])).toBe(prev);
    expect(mergeProcs(prev, [proc("a"), proc("b", { fgComm: "node", fgIsShell: false, ports: [5174] })]).get("b")?.ports).toEqual([5174]);
    // A terminal that closed drops out.
    expect(mergeProcs(prev, [proc("a")]).has("b")).toBe(false);
  });
});

describe("⌘⇧J order", () => {
  it("lists the terminals that need you oldest transition first, never a finished turn", () => {
    const states = new Map<string, TermState>([["a", "your-turn"], ["b", "needs-you"], ["c", "working"], ["d", "needs-you"], ["e", "held"]]);
    const attention = new Map([["a", turn("a", 30)], ["b", needs("b", 10)], ["d", needs("d", 20)], ["e", working("e", 40)]]);
    expect(loudOldestFirst(["a", "b", "c", "d", "e"], states, attention)).toEqual(["b", "d", "e"]);
  });

  it("cycles the whole list by visit, never-visited first, whatever has focus", () => {
    const loud = ["b", "d", "a"];
    const visits = new Map<string, number>();
    let tick = 0;
    const press = () => {
      const target = nextNeedsYou(loud, visits);
      if (target) visits.set(target, ++tick);
      return target;
    };
    expect([press(), press(), press(), press(), press()]).toEqual(["b", "d", "a", "b", "d"]);
    // A newcomer that has never been visited comes next.
    loud.push("e");
    expect(press()).toBe("e");
    expect(nextNeedsYou([], visits)).toBeNull();
  });
});

describe("an agent the samples saw leave (the last walk's killed build)", () => {
  const idle = (id: string, at: number): TermAttention => ({ terminalId: id, sessionId: "s", at, kind: "idle" } as TermAttention);

  it("marks a terminal with an agent in front, and the shell's return as it leaving", () => {
    const none = new Map();
    const one = agentPresence(none, [proc("t", { fgComm: "2.1.312", fgIsShell: false })], new Map(), 100);
    expect(one.get("t")).toEqual({ agent: true, leftAt: null });
    // An unchanged sample is no new map.
    expect(agentPresence(one, [proc("t", { fgComm: "2.1.312", fgIsShell: false })], new Map(), 110)).toBe(one);
    const gone = agentPresence(one, [proc("t")], new Map(), 200);
    expect(gone.get("t")).toEqual({ agent: false, leftAt: 200 });
    // A shell nobody ran an agent in is never "left".
    expect(agentPresence(none, [proc("u")], new Map(), 200).get("u")).toBeUndefined();
    // Another program in front of a terminal an agent left keeps the record.
    expect(agentPresence(gone, [proc("t", { fgComm: "git", fgIsShell: false })], new Map(), 300)).toBe(gone);
  });

  it("reads exited whatever the last hook was, until a new agent speaks", () => {
    const left = { agent: false, leftAt: 200 };
    // The killed build's last hook was the CLI's idle reminder: before, idle.
    expect(agentLeft(left, idle("t", 150))).toBe(true);
    expect(derive({ attention: null, fgComm: "zsh", fgIsShell: true, agentLeft: true })).toBe("exited");
    expect(derive({ attention: "working", fgComm: "zsh", fgIsShell: true, agentLeft: true })).toBe("exited");
    // A hook after the sample is a new agent.
    expect(agentLeft(left, working("t", 250))).toBe(false);
    // A one-shot's answer still unread stays the answer.
    expect(derive({ attention: "your-turn", seen: false, fgComm: "zsh", fgIsShell: true, agentLeft: true })).toBe("your-turn");
    // Serving, or the PTY itself gone, read as before.
    expect(derive({ fgComm: "zsh", fgIsShell: true, ports: [3000], agentLeft: true })).toBe("serving");
    expect(derive({ exited: true, agentLeft: true })).toBe("exited");
    expect(agentLeft(undefined, undefined)).toBe(false);
    expect(agentLeft({ agent: true, leftAt: null }, undefined)).toBe(false);
  });
});
