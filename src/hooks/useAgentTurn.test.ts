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
    // All seven subscriptions requested, nothing invoked yet.
    expect(listen).toHaveBeenCalledTimes(7);
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

// The chat room joins the contract with NOTHING renamed: the backend command
// family is already `companion_send` / `_turn_status` / `_cancel` / `_unqueue`
// and the events are already `companion-delta|done|error|cancelled|
// queue-advanced`. This pins that — a rename on either side breaks it here,
// not in a GUI walk.
describe("the companion surface", () => {
  // `Array.prototype.at` is past this build's lib target; the tail is all we
  // ever want here anyway.
  const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];

  const chatCfg = (): AgentTurnConfig<TurnMessage> =>
    makeCfg({
      surface: "companion",
      key: "chat-1",
      idField: "companionId",
      historyCmd: "companion_get_thread",
      historyArgs: { companionId: "chat-1" },
      sendFailPrefix: "Couldn't reach the chat agent",
      buildSendArgs: (text, extra) => ({
        companionId: "chat-1",
        text,
        cwd: null,
        handoff: extra ?? null,
      }),
    });

  function chatIo() {
    const f = fakeIo();
    f.invokeImpl.set("companion_get_thread", () => []);
    f.invokeImpl.set("companion_turn_status", () => idle);
    f.invokeImpl.set("companion_send", (args) => ({
      started: true,
      queued: false,
      messageId: `m-${String((args as { text: string }).text).slice(0, 4)}`,
    }));
    f.invokeImpl.set("companion_cancel", () => undefined);
    f.invokeImpl.set("companion_unqueue", () => "pulled back");
    return f;
  }

  it("subscribes the companion-* family and probes with companionId", async () => {
    const { io, invokeImpl, handlers, invoke } = chatIo();
    void invokeImpl;
    const ctl = new AgentTurnController<TurnMessage>(chatCfg, io);
    await ctl.attach();
    await flush();
    expect([...handlers.keys()].sort()).toEqual([
      "companion-cancelled",
      "companion-delta",
      "companion-done",
      "companion-error",
      "companion-meter",
      "companion-queue-advanced",
      "companion-retry",
    ]);
    expect(
      invoke.mock.calls.find((c) => c[0] === "companion_turn_status")?.[1],
    ).toEqual({ companionId: "chat-1" });
    ctl.detach();
  });

  it("streams a turn and settles on done", async () => {
    const { io, emit } = chatIo();
    const ctl = new AgentTurnController<TurnMessage>(chatCfg, io);
    await ctl.attach();
    await flush();
    ctl.send("so I've been thinking…");
    await flush();
    expect(ctl.getState().phase).toBe("streaming");
    emit("companion-delta", { companionId: "chat-1", text: "Right — ", seq: 1 });
    emit("companion-delta", { companionId: "chat-1", text: "the anchoring thing.", seq: 2 });
    expect(ctl.getState().liveText).toBe("Right — the anchoring thing.");
    emit("companion-done", {
      companionId: "chat-1",
      messageId: "a1",
      body: "Right — the anchoring thing.",
    });
    expect(ctl.getState().phase).toBe("idle");
    expect(last(ctl.getState().messages)?.body).toBe("Right — the anchoring thing.");
    ctl.detach();
  });

  it("ignores another chat's events entirely", async () => {
    const { io, emit } = chatIo();
    const ctl = new AgentTurnController<TurnMessage>(chatCfg, io);
    await ctl.attach();
    await flush();
    emit("companion-delta", { companionId: "chat-OTHER", text: "not ours", seq: 1 });
    expect(ctl.getState().liveText).toBe("");
    ctl.detach();
  });

  it("carries the handoff target through as the send's extra", async () => {
    // The graduation turn: `→ Draft` is an ordinary send whose extra flags the
    // backend's pending-handoff, so the reply comes back as
    // `companion-handoff-done` even if the room has since unmounted.
    const { io, invoke } = chatIo();
    const ctl = new AgentTurnController<TurnMessage>(chatCfg, io);
    await ctl.attach();
    await flush();
    ctl.send("Distil this…", { localBody: "✦ Take this to a draft", extra: "drafter" });
    await flush();
    const call = invoke.mock.calls.find((c) => c[0] === "companion_send");
    expect(call?.[1]).toMatchObject({
      companionId: "chat-1",
      handoff: "drafter",
      queue: true,
    });
    // The bubble shows the stand-in, not the distillation instruction.
    expect(last(ctl.getState().messages)?.body).toBe("✦ Take this to a draft");
    ctl.detach();
  });

  it("queues a type-ahead send and pulls it back out", async () => {
    const { io, emit, invokeImpl, invoke } = chatIo();
    invokeImpl.set("companion_send", () => ({
      started: false,
      queued: true,
      messageId: "m-queued",
    }));
    const ctl = new AgentTurnController<TurnMessage>(chatCfg, io);
    await ctl.attach();
    await flush();
    ctl.send("and the beta?");
    await flush();
    expect(last(ctl.getState().messages)?.status).toBe("queued");

    // The drain flips the chip off.
    emit("companion-queue-advanced", { companionId: "chat-1", messageId: "m-queued" });
    expect(last(ctl.getState().messages)?.status).toBe("complete");

    // …and the × route reaches the right command with the right key.
    ctl.send("scratch that");
    await flush();
    await expect(ctl.unqueue("m-queued")).resolves.toBe("pulled back");
    expect(
      invoke.mock.calls.find((c) => c[0] === "companion_unqueue")?.[1],
    ).toEqual({ companionId: "chat-1", messageId: "m-queued" });
    ctl.detach();
  });
});

// --- T3.1: the fork contract ------------------------------------------------
//
// The fork family (plan comment threads, drafter sidecars, review annotation
// and question threads) shares this machine but breaks all three naming
// conventions: its registry key is a PAIR, its commands are `fork_thread_*`
// with a per-consumer `send`, and `Turns::begin` rejects-when-busy instead of
// queueing. These pin the three config extensions that let it join.

const forkStatus = (over: Partial<TurnStatus> = {}): TurnStatus => ({
  streaming: false,
  startedAt: null,
  partial: null,
  seq: 0,
  queued: [],
  ...over,
});

function forkCfg(
  over: Partial<AgentTurnConfig<TurnMessage>> = {},
): AgentTurnConfig<TurnMessage> {
  return {
    surface: "fork",
    key: "s-1:c-001",
    idField: null,
    idFields: { sessionId: "s-1", commentId: "c-001" },
    historyCmd: "get_thread",
    historyArgs: { sessionId: "s-1", commentId: "c-001" },
    commands: {
      send: "fork_thread_send",
      status: "fork_thread_status",
      cancel: "fork_thread_cancel",
    },
    statusArgs: { scopeId: "s-1", itemId: "c-001" },
    cancelArgs: { sessionId: "s-1", commentId: "c-001" },
    queueing: false,
    sendFailPrefix: "Couldn't reach the discussion fork",
    buildSendArgs: (text) => ({ sessionId: "s-1", commentId: "c-001", text }),
    makeMessage: ({ id, role, body, status }) => ({ id, role, body, status, createdAt: 999 }),
    ...over,
  };
}

function forkIo() {
  const h = fakeIo();
  h.invokeImpl.set("get_thread", () => []);
  h.invokeImpl.set("fork_thread_status", () => forkStatus());
  h.invokeImpl.set("fork_thread_send", () => undefined);
  h.invokeImpl.set("fork_thread_cancel", () => undefined);
  return h;
}

describe("fork contract", () => {
  it("matches on the composite key, not on either field alone", async () => {
    const { io, emit, invokeImpl } = forkIo();
    invokeImpl.set("fork_thread_status", () => forkStatus());
    const ctl = new AgentTurnController<TurnMessage>(() => forkCfg(), io);
    await ctl.attach();
    await flush();

    // Right session, wrong comment.
    emit("fork-delta", { sessionId: "s-1", commentId: "c-002", text: "X", seq: 1 });
    // Right comment, wrong session — the shape that made two open threads
    // cross-talk when a single id was the whole test.
    emit("fork-delta", { sessionId: "s-2", commentId: "c-001", text: "Y", seq: 1 });
    expect(ctl.getState().liveText).toBe("");
    expect(ctl.getState().phase).toBe("idle");

    emit("fork-delta", { sessionId: "s-1", commentId: "c-001", text: "A", seq: 1 });
    expect(ctl.getState().liveText).toBe("A");
    expect(ctl.getState().phase).toBe("streaming");
    ctl.detach();
  });

  it("routes every leg through the configured command names and args", async () => {
    const { io, invoke, invokeImpl } = forkIo();
    invokeImpl.set("draft_thread_send", () => undefined);
    const ctl = new AgentTurnController<TurnMessage>(
      () => forkCfg({ commands: { ...forkCfg().commands, send: "draft_thread_send" } }),
      io,
    );
    await ctl.attach();
    await flush();

    // Status: `fork_thread_status`, and it takes scopeId/itemId — NOT the
    // sessionId/commentId every other fork command takes.
    expect(invoke.mock.calls.find((c) => c[0] === "fork_thread_status")?.[1]).toEqual({
      scopeId: "s-1",
      itemId: "c-001",
    });
    expect(invoke.mock.calls.find((c) => c[0] === "get_thread")?.[1]).toEqual({
      sessionId: "s-1",
      commentId: "c-001",
    });

    // Send: the per-consumer override wins over `${surface}_send`.
    ctl.send("why this way?");
    await flush();
    const sent = invoke.mock.calls.find((c) => c[0] === "draft_thread_send");
    expect(sent?.[1]).toEqual({ sessionId: "s-1", commentId: "c-001", text: "why this way?" });
    expect(invoke.mock.calls.some((c) => c[0] === "fork_send")).toBe(false);

    // Cancel: its own arg names again.
    ctl.cancel();
    await flush();
    expect(invoke.mock.calls.find((c) => c[0] === "fork_thread_cancel")?.[1]).toEqual({
      sessionId: "s-1",
      commentId: "c-001",
    });
    ctl.detach();
  });

  it("never queues on a rejects-when-busy registry", async () => {
    const { io, emit, invoke, invokeImpl } = forkIo();
    invokeImpl.set("fork_thread_status", () => forkStatus());
    const ctl = new AgentTurnController<TurnMessage>(() => forkCfg(), io);
    await ctl.attach();
    await flush();

    ctl.send("first");
    await flush();
    // No `queue: true` — the fork send command has no such parameter.
    const args = invoke.mock.calls.find((c) => c[0] === "fork_thread_send")?.[1];
    expect(args).toEqual({ sessionId: "s-1", commentId: "c-001", text: "first" });
    expect(ctl.getState().phase).toBe("streaming");

    // A second send mid-turn is dropped rather than drawn as a queued bubble
    // the backend would immediately reject.
    const before = ctl.getState().messages.length;
    ctl.send("second");
    await flush();
    expect(ctl.getState().messages.length).toBe(before);
    expect(invoke.mock.calls.filter((c) => c[0] === "fork_thread_send").length).toBe(1);

    // And once the turn settles, sending works again.
    emit("fork-done", {
      sessionId: "s-1",
      commentId: "c-001",
      messageId: "m-1",
      body: "because.",
    });
    expect(ctl.getState().phase).toBe("idle");
    ctl.send("second");
    await flush();
    expect(invoke.mock.calls.filter((c) => c[0] === "fork_thread_send").length).toBe(2);

    // Unqueue is inert — nothing was ever queued.
    await expect(ctl.unqueue("m-1")).resolves.toBe(null);
    expect(invoke.mock.calls.some((c) => c[0] === "fork_unqueue")).toBe(false);
    ctl.detach();
  });

  it("keeps the turn streaming across an auto-retry without doubling the bubble", async () => {
    const { io, emit, invokeImpl } = forkIo();
    invokeImpl.set("fork_thread_status", () => forkStatus());
    const ctl = new AgentTurnController<TurnMessage>(() => forkCfg(), io);
    await ctl.attach();
    await flush();
    ctl.send("why?");
    await flush();
    const asked = ctl.getState().messages.length;
    expect(ctl.getState().phase).toBe("streaming");

    // The backend hit a transient error and is quietly running the turn again.
    emit("fork-retry", { sessionId: "s-1", commentId: "c-001", attempt: 2 });
    const s = ctl.getState();
    expect(s.phase).toBe("streaming");
    expect(s.retrying).toBe(true);
    // Nothing terminal happened: no error row, and the question is not re-asked.
    expect(s.messages.length).toBe(asked);
    expect(s.messages.some((m) => m.status === "error")).toBe(false);

    // The retry's first delta ends the caption and streams normally.
    emit("fork-delta", { sessionId: "s-1", commentId: "c-001", text: "Because", seq: 1 });
    expect(ctl.getState().retrying).toBe(false);
    expect(ctl.getState().liveText).toBe("Because");

    emit("fork-done", {
      sessionId: "s-1",
      commentId: "c-001",
      messageId: "m-1",
      body: "Because.",
    });
    const done = ctl.getState();
    expect(done.phase).toBe("idle");
    expect(done.retrying).toBe(false);
    expect(done.messages.length).toBe(asked + 1);
    ctl.detach();
  });

  it("ignores a retry event that lands after the turn already settled", async () => {
    const { io, emit, invokeImpl } = forkIo();
    invokeImpl.set("fork_thread_status", () => forkStatus());
    const ctl = new AgentTurnController<TurnMessage>(() => forkCfg(), io);
    await ctl.attach();
    await flush();
    ctl.send("why?");
    await flush();
    emit("fork-error", {
      sessionId: "s-1",
      commentId: "c-001",
      error: "The model hit a temporary error on this turn.",
    });
    expect(ctl.getState().phase).toBe("error");

    emit("fork-retry", { sessionId: "s-1", commentId: "c-001", attempt: 2 });
    // A late event must not reanimate a bubble the reviewer already sees as
    // finished (and is looking at a Retry button under).
    expect(ctl.getState().phase).toBe("error");
    expect(ctl.getState().retrying).toBe(false);
    ctl.detach();
  });

  it("restores a mid-turn stream from the probe and folds only new deltas", async () => {
    const { io, emit, invokeImpl } = forkIo();
    invokeImpl.set("fork_thread_status", () =>
      forkStatus({ streaming: true, startedAt: 500, partial: "AB", seq: 2 }),
    );
    const ctl = new AgentTurnController<TurnMessage>(() => forkCfg(), io);
    await ctl.attach();
    await flush();
    expect(ctl.getState().phase).toBe("streaming");
    expect(ctl.getState().liveText).toBe("AB");
    expect(ctl.getState().startedAt).toBe(500);

    emit("fork-delta", { sessionId: "s-1", commentId: "c-001", text: "B", seq: 2 });
    emit("fork-delta", { sessionId: "s-1", commentId: "c-001", text: "C", seq: 3 });
    expect(ctl.getState().liveText).toBe("ABC");
    ctl.detach();
  });
});
