// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  blockerMessage,
  composerReadiness,
  enqueueSend,
  nextFlush,
  promoteSend,
  routeSend,
  unqueueSend,
  type ComposerBlocker,
  type QueuedSend,
} from "./readiness";

describe("composer readiness", () => {
  it.each<[string, Parameters<typeof composerReadiness>[0], boolean, ComposerBlocker | null, boolean]>([
    ["no terminal", { terminalId: null, bound: true, host: { ready: true, blocker: null }, harness: "claude" }, false, "no_terminal", false],
    ["not bound, host silent", { terminalId: "t", bound: false, host: null, harness: "claude" }, false, "unbound", false],
    ["bound, host silent: the send is the check", { terminalId: "t", bound: true, host: null, harness: "claude" }, true, null, false],
    ["host: ready", { terminalId: "t", bound: true, host: { ready: true, blocker: null }, harness: "claude" }, true, null, false],
    ["host: no paste mode yet", { terminalId: "t", bound: true, host: { ready: false, blocker: "no_paste_mode" }, harness: "claude" }, false, "no_paste_mode", false],
    ["host: a native dialog", { terminalId: "t", bound: true, host: { ready: false, blocker: "native_dialog" }, harness: "claude" }, false, "native_dialog", true],
    ["host: dirty input", { terminalId: "t", bound: true, host: { ready: false, blocker: "dirty_input" }, harness: "codex" }, false, "dirty_input", true],
    ["host: not ready, no reason", { terminalId: "t", bound: true, host: { ready: false, blocker: null }, harness: "claude" }, false, "unbound", false],
    ["host outranks bound", { terminalId: "t", bound: false, host: { ready: true, blocker: null }, harness: "claude" }, true, null, false],
  ])("%s", (_label, input, ready, blocker, terminalFix) => {
    const r = composerReadiness(input);
    expect(r).toMatchObject({ ready, blocker, terminalFix });
    expect(r.message === null).toBe(ready);
  });

  it("names the harness, and the dirty-input warning says what would happen", () => {
    expect(blockerMessage("unbound", "codex")).toContain("Codex");
    expect(blockerMessage("native_dialog", "claude")).toContain("Claude is asking");
    expect(blockerMessage("dirty_input", "claude")).toMatch(/unsent text in the terminal.*would add to it/);
  });
});

describe("the local queue", () => {
  const q = (id: string, text = id): QueuedSend => ({ id, text, at: 0 });

  it.each<[string, boolean, number, "send" | "queue"]>([
    ["ready, empty queue: send", true, 0, "send"],
    ["ready, older sends waiting: queue behind them", true, 2, "queue"],
    ["not ready: queue", false, 0, "queue"],
  ])("%s", (_label, ready, waiting, route) => {
    expect(routeSend({ ready }, Array.from({ length: waiting }, (_, i) => q(`q${i}`)))).toBe(route);
  });

  it("enqueue keeps order and refuses a duplicate id", () => {
    const one = enqueueSend([], q("a"));
    const two = enqueueSend(one, q("b"));
    expect(enqueueSend(two, q("a")).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("× hands the text back; ↑ Next moves it to the front", () => {
    const queue = [q("a", "first"), q("b", "second"), q("c", "third")];
    expect(unqueueSend(queue, "b")).toEqual({ queue: [queue[0], queue[2]], text: "second" });
    expect(unqueueSend(queue, "zz")).toEqual({ queue, text: null });
    expect(promoteSend(queue, "c").map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(promoteSend(queue, "zz").map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it.each<[string, boolean, boolean, boolean, string | null]>([
    ["ready, idle: the oldest", true, false, false, "a"],
    ["not ready: nothing", false, false, false, null],
    ["one already typing: nothing", true, true, false, null],
    ["refused, and the host hasn't spoken since: wait", true, false, true, null],
  ])("%s", (_label, ready, inFlight, held, next) => {
    expect(nextFlush([q("a"), q("b")], { ready }, { inFlight, held })?.id ?? null).toBe(next);
  });

  it("an empty queue flushes nothing", () => {
    expect(nextFlush([], { ready: true }, { inFlight: false, held: false })).toBeNull();
  });
});
