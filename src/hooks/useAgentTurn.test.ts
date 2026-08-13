// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnStatus } from "../types";
import type { TurnMessage } from "../lib/agentTurn";
import {
  AgentTurnController,
  HEAL_INTERVAL_MS,
  type AgentTurnConfig,
  type AgentTurnIo,
} from "./useAgentTurn";

type Handler = (e: { payload: unknown }) => void;

/** A scriptable Tauri: handlers by event name, invoke routed per command. */
function fakeIo(opts?: { holdListens?: boolean }) {
  const handlers = new Map<string, Handler>();
  const releases: Array<() => void> = [];
  const invokeImpl = new Map<string, (args?: Record<string, unknown>) => unknown>();
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const impl = invokeImpl.get(cmd);
    if (!impl) throw new Error(`unexpected invoke: ${cmd}`);
    return impl(args);
  });
  const listen = vi.fn((event: string, fn: Handler) => {
    handlers.set(event, fn);
    const un = () => handlers.delete(event);
    if (!opts?.holdListens) return Promise.resolve(un);
    return new Promise<() => void>((res) => releases.push(() => res(un)));
  });
  const io: AgentTurnIo = {
    invoke: invoke as AgentTurnIo["invoke"],
    listen: listen as unknown as AgentTurnIo["listen"],
  };
  const emit = (event: string, payload: unknown) => handlers.get(event)?.({ payload });
  return { io, emit, releases, invokeImpl, handlers, invoke, listen };
}

const rows = (...ms: Array<Partial<TurnMessage> & { id: string }>): TurnMessage[] =>
  ms.map((m) => ({
    role: "assistant",
    body: `body-${m.id}`,
    status: "complete",
    createdAt: 1,
    ...m,
  }));

const idle: TurnStatus = { streaming: false, startedAt: null, partial: null, seq: 0, queued: [] };
const streamingAt = (seq: number, partial: string): TurnStatus => ({
  streaming: true,
  startedAt: 500,
  partial,
  seq,
  queued: [],
});

function makeCfg(over: Partial<AgentTurnConfig<TurnMessage>> = {}): AgentTurnConfig<TurnMessage> {
  return {
    surface: "linked",
    key: "L1",
    idField: "linkedId",
    historyCmd: "linked_get_thread",
    historyArgs: { linkedId: "L1" },
    sendFailPrefix: "Couldn't reach the linked discussion",
    buildSendArgs: (text) => ({ linkedId: "L1", text }),
    makeMessage: ({ id, role, body, status }) => ({ id, role, body, status, createdAt: 999 }),
    ...over,
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("mount ordering", () => {
  it("holds the history + status probes until every listener is registered", async () => {
    const { io, releases, invokeImpl, invoke, listen } = fakeIo({ holdListens: true });
    invokeImpl.set("linked_get_thread", () => rows({ id: "a1" }));
    invokeImpl.set("linked_turn_status", () => idle);
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    const attached = ctl.attach();
    await flush();
    // All five subscriptions requested, nothing invoked yet.
    expect(listen).toHaveBeenCalledTimes(5);
    expect(invoke).not.toHaveBeenCalled();
    releases.forEach((r) => r());
    await attached;
    await flush();
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("linked_get_thread");
    expect(cmds).toContain("linked_turn_status");
    expect(ctl.getState().loaded).toBe(true);
    expect(ctl.getState().messages.map((m) => m.id)).toEqual(["a1"]);
    ctl.detach();
  });

  it("restores a mid-turn stream from the probe, then folds only the new deltas", async () => {
    const { io, emit, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => rows({ id: "u1", role: "user" }));
    invokeImpl.set("linked_turn_status", () => streamingAt(2, "AB"));
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    await flush();
    expect(ctl.getState().phase).toBe("streaming");
    expect(ctl.getState().liveText).toBe("AB");
    expect(ctl.getState().startedAt).toBe(500);
    // A delta the probe already folded in, then a genuinely new one.
    emit("linked-delta", { linkedId: "L1", text: "B", seq: 2 });
    emit("linked-delta", { linkedId: "L1", text: "C", seq: 3 });
    expect(ctl.getState().liveText).toBe("ABC");
    ctl.detach();
  });

  it("ignores events for other keys, and a singleton surface accepts everything", async () => {
    const { io, emit, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    emit("linked-delta", { linkedId: "OTHER", text: "X", seq: 1 });
    expect(ctl.getState().liveText).toBe("");
    ctl.detach();

    const mem = fakeIo();
    mem.invokeImpl.set("memchat_thread", () => []);
    mem.invokeImpl.set("memchat_turn_status", () => idle);
    const mctl = new AgentTurnController<TurnMessage>(
      () =>
        makeCfg({
          surface: "memchat",
          key: "memchat",
          idField: null,
          historyCmd: "memchat_thread",
          historyArgs: {},
        }),
      mem.io,
    );
    await mctl.attach();
    await flush();
    // Singleton probes carry no key args.
    const statusCall = mem.invoke.mock.calls.find((c) => c[0] === "memchat_turn_status");
    expect(statusCall?.[1]).toEqual({});
    mem.emit("memchat-delta", { threadId: "memchat", text: "A", seq: 1 });
    expect(mctl.getState().liveText).toBe("A");
    mctl.detach();
  });
});

describe("terminal events through the controller", () => {
  it("done lands the reply row built by makeMessage and settles idle", async () => {
    const { io, emit, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    emit("linked-delta", { linkedId: "L1", text: "A", seq: 1 });
    emit("linked-done", { linkedId: "L1", messageId: "a-db", body: "full" });
    const s = ctl.getState();
    expect(s.phase).toBe("idle");
    expect(s.liveText).toBe("");
    expect(s.messages.map((m) => m.id)).toEqual(["a-db"]);
    expect(s.messages[0].body).toBe("full");
    ctl.detach();
  });

  it("error appends the event's message as an error bubble", async () => {
    const { io, emit, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    emit("linked-error", { linkedId: "L1", error: "boom" });
    const s = ctl.getState();
    expect(s.phase).toBe("error");
    expect(s.messages[0].body).toBe("boom");
    expect(s.messages[0].status).toBe("error");
    ctl.detach();
  });
});

describe("self-heal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("settles a stuck stream after two consecutive idle probes, refetching the thread", async () => {
    const { io, emit, invokeImpl } = fakeIo();
    let thread = rows({ id: "u1", role: "user", body: "q" });
    invokeImpl.set("linked_get_thread", () => thread);
    invokeImpl.set("linked_turn_status", () => idle);
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    await flush();
    // A turn starts streaming, then its terminal event is lost forever.
    emit("linked-delta", { linkedId: "L1", text: "A", seq: 1 });
    expect(ctl.getState().phase).toBe("streaming");
    // The reader persisted the settled pair before we ever re-probe.
    thread = rows(
      { id: "u1", role: "user", body: "q" },
      { id: "a1", body: "the lost reply", createdAt: 2 },
    );
    await vi.advanceTimersByTimeAsync(HEAL_INTERVAL_MS); // miss 1 — still streaming
    expect(ctl.getState().phase).toBe("streaming");
    await vi.advanceTimersByTimeAsync(HEAL_INTERVAL_MS); // miss 2 — settle
    await flush();
    const s = ctl.getState();
    expect(s.phase).toBe("idle");
    expect(s.liveText).toBe("");
    expect(s.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    ctl.detach();
  });

  it("a done event between misses disarms the counter (no spurious refetch)", async () => {
    const { io, emit, invokeImpl, invoke } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    await flush();
    const historyCallsAfterMount = invoke.mock.calls.filter(
      (c) => c[0] === "linked_get_thread",
    ).length;
    emit("linked-delta", { linkedId: "L1", text: "A", seq: 1 });
    await vi.advanceTimersByTimeAsync(HEAL_INTERVAL_MS); // miss 1
    emit("linked-done", { linkedId: "L1", messageId: "a1", body: "full" }); // the race resolves
    expect(ctl.getState().phase).toBe("idle");
    // The clock stops with the stream; no settle-refetch ever fires.
    await vi.advanceTimersByTimeAsync(HEAL_INTERVAL_MS * 4);
    expect(
      invoke.mock.calls.filter((c) => c[0] === "linked_get_thread").length,
    ).toBe(historyCallsAfterMount);
    ctl.detach();
  });

  it("a streaming probe refreshes the text and keeps the counter at zero", async () => {
    const { io, emit, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    let probes = 0;
    invokeImpl.set("linked_turn_status", () => {
      probes += 1;
      return probes <= 1 ? idle : streamingAt(5, "ABCDE");
    });
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    await flush();
    emit("linked-delta", { linkedId: "L1", text: "A", seq: 1 });
    await vi.advanceTimersByTimeAsync(HEAL_INTERVAL_MS);
    // The re-probe repaired the missed deltas 2..5.
    expect(ctl.getState().liveText).toBe("ABCDE");
    expect(ctl.getState().phase).toBe("streaming");
    ctl.detach();
  });
});

describe("send", () => {
  it("appends the optimistic row, dispatches the built args with queue: true, and reconciles the outcome id", async () => {
    const { io, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    const sent: unknown[] = [];
    invokeImpl.set("linked_send", (args) => {
      sent.push(args);
      return { started: true, queued: false, messageId: "u-db" };
    });
    const ctl = new AgentTurnController<TurnMessage>(
      () =>
        makeCfg({
          buildSendArgs: async (text, extra) => ({ linkedId: "L1", text, extra: extra ?? null }),
        }),
      io,
    );
    await ctl.attach();
    await flush();
    ctl.send("  hello  ", { localBody: "✦ shown instead", extra: { synthesize: true } });
    expect(ctl.getState().phase).toBe("streaming");
    expect(ctl.getState().messages[ctl.getState().messages.length - 1]?.body).toBe("✦ shown instead");
    await flush();
    expect(sent).toEqual([
      { linkedId: "L1", text: "hello", extra: { synthesize: true }, queue: true },
    ]);
    // The optimistic row now carries the persisted id.
    expect(ctl.getState().messages[0]?.id).toBe("u-db");
    ctl.detach();
  });

  it("a send while streaming is type-ahead: it dispatches, queues the bubble, and leaves the stream alone", async () => {
    const { io, emit, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    const sent: unknown[] = [];
    invokeImpl.set("linked_send", (args) => {
      sent.push(args);
      return { started: false, queued: true, messageId: "q-db" };
    });
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    await flush();
    // A turn is streaming…
    emit("linked-delta", { linkedId: "L1", text: "partial ", seq: 1 });
    expect(ctl.getState().phase).toBe("streaming");
    // …and the user types ahead.
    ctl.send("next question");
    await flush();
    expect(sent).toHaveLength(1);
    const s = ctl.getState();
    // The live stream must survive the type-ahead untouched.
    expect(s.liveText).toBe("partial ");
    const queuedRow = s.messages[s.messages.length - 1];
    expect(queuedRow?.id).toBe("q-db");
    expect(queuedRow?.status).toBe("queued");
    // The drain announces the queued turn going live.
    emit("linked-queue-advanced", { linkedId: "L1", messageId: "q-db" });
    expect(ctl.getState().messages[ctl.getState().messages.length - 1]?.status).toBe("complete");
    expect(ctl.getState().phase).toBe("streaming");
    ctl.detach();
  });

  it("unqueue restores the text and removes the queued row; a late unqueue leaves it", async () => {
    const { io, emit, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    invokeImpl.set("linked_send", () => ({ started: false, queued: true, messageId: "q-db" }));
    let queueText: string | null = "next question";
    invokeImpl.set("linked_unqueue", (args) => {
      expect(args).toEqual({ linkedId: "L1", messageId: "q-db" });
      return queueText;
    });
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    await flush();
    emit("linked-delta", { linkedId: "L1", text: "busy", seq: 1 });
    ctl.send("next question");
    await flush();
    expect(await ctl.unqueue("q-db")).toBe("next question");
    expect(ctl.getState().messages.some((m) => m.id === "q-db")).toBe(false);
    // Too late — the send already advanced; the row stays.
    ctl.send("another");
    await flush();
    queueText = null;
    expect(await ctl.unqueue("q-db")).toBeNull();
    ctl.detach();
  });

  it("a failed send lands the sendFailPrefix error bubble and marks the row unsent", async () => {
    const { io, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    invokeImpl.set("linked_send", () => {
      throw new Error("daemon down");
    });
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    await flush();
    ctl.send("hello");
    await flush();
    const s = ctl.getState();
    expect(s.phase).toBe("error");
    expect(s.messages[s.messages.length - 1]?.body).toMatch(/^Couldn't reach the linked discussion: /);
    // The user row is truthfully "unsent", ready for a resend affordance.
    expect(s.messages[0]?.status).toBe("unsent");
    ctl.detach();
  });

  it("drops a send whose args were still building when the panel went away", async () => {
    const { io, invokeImpl, invoke } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    invokeImpl.set("linked_send", () => undefined);
    let release!: (v: Record<string, unknown>) => void;
    const ctl = new AgentTurnController<TurnMessage>(
      () =>
        makeCfg({
          buildSendArgs: () => new Promise((res) => (release = res)),
        }),
      io,
    );
    await ctl.attach();
    await flush();
    ctl.send("hello");
    ctl.detach(); // tab switch mid-snapshot-capture
    release({ linkedId: "L1", text: "hello" });
    await flush();
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain("linked_send");
  });
});

describe("cancel and clear", () => {
  it("cancel invokes the surface's cancel with the key args", async () => {
    const { io, invokeImpl, invoke } = fakeIo();
    invokeImpl.set("linked_get_thread", () => []);
    invokeImpl.set("linked_turn_status", () => idle);
    invokeImpl.set("linked_cancel", () => undefined);
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    ctl.cancel();
    await flush();
    const call = invoke.mock.calls.find((c) => c[0] === "linked_cancel");
    expect(call?.[1]).toEqual({ linkedId: "L1" });
    ctl.detach();
  });

  it("clear empties the thread but stays loaded (empty-state hint, not blank)", async () => {
    const { io, invokeImpl } = fakeIo();
    invokeImpl.set("linked_get_thread", () => rows({ id: "a1" }));
    invokeImpl.set("linked_turn_status", () => idle);
    const ctl = new AgentTurnController<TurnMessage>(() => makeCfg(), io);
    await ctl.attach();
    await flush();
    expect(ctl.getState().messages).toHaveLength(1);
    ctl.clear();
    expect(ctl.getState().messages).toHaveLength(0);
    expect(ctl.getState().loaded).toBe(true);
    ctl.detach();
  });
});
