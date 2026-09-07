// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { TurnStatus } from "../types";
import {
  ACTIVITY_KEEP,
  initialTurnState,
  reduceTurn,
  type TurnAction,
  type TurnMessage,
  type TurnState,
} from "./agentTurn";
import { emptyMeter, type TurnMeter } from "./turnMeter";

const msg = (over: Partial<TurnMessage> = {}): TurnMessage => ({
  id: "m1",
  role: "assistant",
  body: "hello",
  status: "complete",
  createdAt: 1000,
  ...over,
});

const status = (over: Partial<TurnStatus> = {}): TurnStatus => ({
  streaming: false,
  startedAt: null,
  partial: null,
  seq: 0,
  queued: [],
  ...over,
});

function run(
  actions: TurnAction<TurnMessage>[],
  from: TurnState<TurnMessage> = initialTurnState(),
): TurnState<TurnMessage> {
  return actions.reduce(reduceTurn, from);
}

describe("the seq seam (probe × delta interleavings)", () => {
  it("drops deltas already folded into the probed partial", () => {
    const s = run([
      { type: "probe", status: status({ streaming: true, startedAt: 50, partial: "AB", seq: 2 }) },
      { type: "delta", seq: 1, text: "A" },
      { type: "delta", seq: 2, text: "B" },
    ]);
    expect(s.liveText).toBe("AB");
    expect(s.lastSeq).toBe(2);
    expect(s.phase).toBe("streaming");
    expect(s.startedAt).toBe(50);
  });

  it("appends the first delta past the watermark (boundary: seq == watermark drops, +1 appends)", () => {
    const s = run([
      { type: "probe", status: status({ streaming: true, partial: "AB", seq: 2 }) },
      { type: "delta", seq: 2, text: "B" },
      { type: "delta", seq: 3, text: "C" },
    ]);
    expect(s.liveText).toBe("ABC");
    expect(s.lastSeq).toBe(3);
  });

  it("ignores a probe snapshot older than the deltas already applied", () => {
    // Deltas 1..3 landed while the probe response was still on the wire.
    const s = run([
      { type: "delta", seq: 1, text: "A" },
      { type: "delta", seq: 2, text: "B" },
      { type: "delta", seq: 3, text: "C" },
      { type: "probe", status: status({ streaming: true, startedAt: 50, partial: "A", seq: 1 }) },
    ]);
    expect(s.liveText).toBe("ABC");
    expect(s.lastSeq).toBe(3);
    // The probe still contributes what only it knows.
    expect(s.startedAt).toBe(50);
  });

  it("adopts a probe snapshot ahead of the applied deltas (missed-delta repair)", () => {
    const s = run([
      { type: "delta", seq: 1, text: "A" },
      { type: "probe", status: status({ streaming: true, partial: "ABCD", seq: 4 }) },
      { type: "delta", seq: 4, text: "D" },
      { type: "delta", seq: 5, text: "E" },
    ]);
    expect(s.liveText).toBe("ABCDE");
    expect(s.lastSeq).toBe(5);
  });
});

describe("the settled latch (stale probes after a terminal event)", () => {
  it("ignores a stale streaming probe after done", () => {
    const s = run([
      { type: "delta", seq: 1, text: "A" },
      { type: "done", message: msg({ id: "a1", body: "final" }) },
      { type: "probe", status: status({ streaming: true, partial: "A", seq: 1 }) },
    ]);
    expect(s.phase).toBe("idle");
    expect(s.liveText).toBe("");
  });

  it("ignores a stale streaming probe after cancelled", () => {
    const s = run([
      { type: "delta", seq: 1, text: "A" },
      { type: "cancelled" },
      { type: "probe", status: status({ streaming: true, partial: "A", seq: 1 }) },
    ]);
    expect(s.phase).toBe("idle");
    expect(s.liveText).toBe("");
  });

  it("a delta after a terminal clears the latch — the next probe applies", () => {
    // A new turn the panel didn't start (e.g. Phase 3 queue drain) announces
    // itself with deltas; probes must work again from that moment.
    const s = run([
      { type: "done", message: msg({ id: "a1" }) },
      { type: "delta", seq: 1, text: "N" },
      { type: "probe", status: status({ streaming: true, startedAt: 90, partial: "New", seq: 3 }) },
    ]);
    expect(s.phase).toBe("streaming");
    expect(s.liveText).toBe("New");
    expect(s.startedAt).toBe(90);
  });

  it("a send clears the latch", () => {
    const s = run([
      { type: "done", message: msg({ id: "a1" }) },
      { type: "send-optimistic", message: msg({ id: "tmp1", role: "user", body: "next" }) },
      { type: "probe", status: status({ streaming: true, partial: "R", seq: 1 }) },
    ]);
    expect(s.phase).toBe("streaming");
    expect(s.liveText).toBe("R");
  });

  it("an idle probe never forces idle mid-stream (self-heal owns that verdict)", () => {
    const s = run([
      { type: "delta", seq: 1, text: "A" },
      { type: "probe", status: status({ streaming: false }) },
    ]);
    expect(s.phase).toBe("streaming");
    expect(s.liveText).toBe("A");
  });
});

describe("terminal events", () => {
  it("done clears the live reply, appends the settled row, and resets the watermark", () => {
    const s = run([
      { type: "delta", seq: 41, text: "A" },
      { type: "done", message: msg({ id: "a1", body: "full reply" }) },
    ]);
    expect(s.liveText).toBe("");
    expect(s.phase).toBe("idle");
    expect(s.startedAt).toBeNull();
    expect(s.messages.map((m) => m.id)).toEqual(["a1"]);
    // The next turn's deltas start at seq 1 — the watermark must not eat them.
    const next = reduceTurn(s, { type: "delta", seq: 1, text: "N" });
    expect(next.liveText).toBe("N");
  });

  it("done dedupes by messageId (self-heal refetch beat the late done event)", () => {
    const refetched = msg({ id: "a1", body: "full reply" });
    const s = run([
      { type: "history", rows: [refetched] },
      { type: "done", message: msg({ id: "a1", body: "full reply" }) },
    ]);
    expect(s.messages).toHaveLength(1);
  });

  it("error appends once even when the persisted row was already refetched", () => {
    const persisted = msg({ id: "e-db", body: "boom", status: "error" });
    const s = run([
      { type: "history", rows: [persisted] },
      { type: "error", message: msg({ id: "tmp-9", body: "boom", status: "error" }) },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.phase).toBe("error");
    expect(s.liveText).toBe("");
  });

  it("cancelled clears the stream without appending anything", () => {
    const s = run([
      { type: "delta", seq: 1, text: "A" },
      { type: "cancelled" },
    ]);
    expect(s.messages).toHaveLength(0);
    expect(s.phase).toBe("idle");
    expect(s.liveText).toBe("");
  });
});

describe("history merge", () => {
  it("first load replaces the empty list and flips loaded", () => {
    const rows = [msg({ id: "u1", role: "user" }), msg({ id: "a1" })];
    const s = run([{ type: "history", rows }]);
    expect(s.messages).toEqual(rows);
    expect(s.loaded).toBe(true);
  });

  it("an empty (or failed) load still flips loaded", () => {
    const s = run([{ type: "history", rows: [] }]);
    expect(s.loaded).toBe(true);
    expect(s.messages).toEqual([]);
  });

  it("dedupes by id, then by text key for optimistic rows without a real id", () => {
    const local = [
      msg({ id: "a1", body: "settled reply" }),
      msg({ id: "tmp-1", role: "user", body: "my question", createdAt: 2000 }),
    ];
    const rows = [
      msg({ id: "a1", body: "settled reply" }), // id match
      msg({ id: "u-db", role: "user", body: "my question", createdAt: 1990 }), // text-key match
    ];
    const s = run([{ type: "history", rows }], {
      ...initialTurnState<TurnMessage>(),
      messages: local,
    });
    expect(s.messages.map((m) => m.id)).toEqual(["a1", "tmp-1"]);
  });

  it("a refetched terminal row lands after the optimistic user row that produced it", () => {
    // The self-heal case: the done event was lost, the refetch carries the
    // persisted pair; only the assistant row is new locally.
    const local = [msg({ id: "tmp-1", role: "user", body: "q", createdAt: 2000 })];
    const rows = [
      msg({ id: "u-db", role: "user", body: "q", createdAt: 1995 }),
      msg({ id: "a-db", body: "late reply", createdAt: 2400 }),
    ];
    const s = run([{ type: "history", rows }], {
      ...initialTurnState<TurnMessage>(),
      messages: local,
    });
    expect(s.messages.map((m) => m.id)).toEqual(["tmp-1", "a-db"]);
  });

  it("a repeated question is not a duplicate (id equality wins over text)", () => {
    const rows = [
      msg({ id: "u1", role: "user", body: "again?", createdAt: 100 }),
      msg({ id: "a1", body: "yes", createdAt: 200 }),
      msg({ id: "u2", role: "user", body: "again?", createdAt: 300 }),
    ];
    const s = run([{ type: "history", rows }]);
    expect(s.messages).toHaveLength(3);
  });
});

describe("sending", () => {
  it("send-optimistic appends the user row and restarts the stream state", () => {
    const before = run([
      { type: "probe", status: status({ streaming: true, partial: "old", seq: 7 }) },
      { type: "done", message: msg({ id: "a1" }) },
    ]);
    const s = reduceTurn(before, {
      type: "send-optimistic",
      message: msg({ id: "tmp-1", role: "user", body: "go", createdAt: 3000 }),
    });
    expect(s.phase).toBe("streaming");
    expect(s.liveText).toBe("");
    expect(s.lastSeq).toBe(0);
    expect(s.startedAt).toBe(3000);
    expect(s.messages[s.messages.length - 1]?.id).toBe("tmp-1");
  });

  it("send-resolved swaps the temp id and marks a queued row", () => {
    const s = run([
      { type: "send-optimistic", message: msg({ id: "tmp-1", role: "user", body: "go" }) },
      { type: "send-resolved", tmpId: "tmp-1", messageId: "u-db", queued: true },
    ]);
    expect(s.messages[0].id).toBe("u-db");
    expect(s.messages[0].status).toBe("queued");
  });

  it("a type-ahead send leaves the live stream untouched and guesses queued", () => {
    const s = run([
      { type: "delta", seq: 3, text: "mid-stream" },
      { type: "send-optimistic", message: msg({ id: "tmp-1", role: "user", body: "next" }) },
    ]);
    expect(s.liveText).toBe("mid-stream");
    expect(s.lastSeq).toBe(3);
    expect(s.phase).toBe("streaming");
    expect(s.messages[0].status).toBe("queued");
  });

  it("send-resolved corrects a wrong queued guess back to a plain sent row", () => {
    // The in-flight turn ended between the optimistic snapshot and the send:
    // the backend started the turn instead of queueing.
    const s = run([
      { type: "delta", seq: 1, text: "old" },
      { type: "send-optimistic", message: msg({ id: "tmp-1", role: "user", body: "next" }) },
      { type: "send-resolved", tmpId: "tmp-1", messageId: "u-db", queued: false },
    ]);
    expect(s.messages[0].id).toBe("u-db");
    expect(s.messages[0].status).toBe("complete");
  });

  it("send-failed marks the row unsent (never a phantom sent/queued bubble)", () => {
    const s = run([
      { type: "send-optimistic", message: msg({ id: "tmp-1", role: "user", body: "go" }) },
      { type: "send-failed", tmpId: "tmp-1" },
    ]);
    expect(s.messages[0].status).toBe("unsent");
  });

  it("queue-advanced flips the queued row live and restarts the stream state", () => {
    const s = run([
      { type: "send-optimistic", message: msg({ id: "tmp-1", role: "user", body: "go" }) },
      { type: "send-resolved", tmpId: "tmp-1", messageId: "u-db", queued: true },
      { type: "queue-advanced", messageId: "u-db" },
    ]);
    expect(s.messages[0].status).toBe("complete");
    expect(s.phase).toBe("streaming");
    expect(s.lastSeq).toBe(0);
  });

  it("queue-advanced drops the advanced entry from the probed queue list", () => {
    const queued = [
      { messageId: "q1", text: "first", queuedAt: 1 },
      { messageId: "q2", text: "second", queuedAt: 2 },
    ];
    const s = run([
      { type: "probe", status: status({ streaming: true, partial: "A", seq: 1, queued }) },
      { type: "queue-advanced", messageId: "q1" },
    ]);
    expect(s.queued.map((q) => q.messageId)).toEqual(["q2"]);
  });

  it("unqueued removes the row and its queue entry", () => {
    const queued = [{ messageId: "u-db", text: "go", queuedAt: 1 }];
    const s = run([
      { type: "probe", status: status({ streaming: true, partial: "A", seq: 1, queued }) },
      { type: "send-optimistic", message: msg({ id: "tmp-1", role: "user", body: "go" }) },
      { type: "send-resolved", tmpId: "tmp-1", messageId: "u-db", queued: true },
      { type: "unqueued", messageId: "u-db" },
    ]);
    expect(s.messages.some((m) => m.id === "u-db")).toBe(false);
    expect(s.queued).toHaveLength(0);
  });
});

describe("settle and reset", () => {
  it("settle drops a stuck stream and latches against stale probes", () => {
    const s = run([
      { type: "delta", seq: 1, text: "A" },
      { type: "settle" },
      { type: "probe", status: status({ streaming: true, partial: "A", seq: 1 }) },
    ]);
    expect(s.phase).toBe("idle");
    expect(s.liveText).toBe("");
  });

  it("reset returns to the initial state (key switch)", () => {
    const s = run([
      { type: "history", rows: [msg()] },
      { type: "delta", seq: 1, text: "A" },
      { type: "reset" },
    ]);
    expect(s).toEqual(initialTurnState());
  });
});

// --- the token/provenance meter --------------------------------------------

const meter = (over: Partial<TurnMeter> = {}): TurnMeter => ({
  ...emptyMeter(),
  ...over,
});

describe("the meter", () => {
  it("merges by rev and drops a stale event", () => {
    const s = run([
      { type: "meter", meter: meter({ rev: 2, outputTokens: 40 }) },
      { type: "meter", meter: meter({ rev: 1, outputTokens: 9 }) },
    ]);
    expect(s.meter?.rev).toBe(2);
    expect(s.meter?.outputTokens).toBe(40);
  });

  it("appends activity, newest last, bounded", () => {
    const many: TurnAction<TurnMessage>[] = Array.from({ length: 60 }, (_, i) => ({
      type: "meter" as const,
      meter: meter({ rev: i + 1 }),
      activity: { at: i, kind: "tool", label: `t${i}` },
    }));
    const s = run(many);
    expect(s.activity).toHaveLength(ACTIVITY_KEEP);
    expect(s.activity[s.activity.length - 1]?.label).toBe("t59");
  });

  it("adopts the probe's meter and ring on a remount", () => {
    const s = run([
      {
        type: "probe",
        status: status({
          streaming: true,
          partial: "A",
          seq: 1,
          meter: meter({ rev: 7, model: "claude-opus-5", outputTokens: 12 }),
          activity: [{ at: 1, kind: "tool", label: "Grep…" }],
        }),
      },
    ]);
    expect(s.meter?.model).toBe("claude-opus-5");
    expect(s.activity).toHaveLength(1);
  });

  /** The probe is a command round trip: it can be BEHIND on the meter even
   *  while it is ahead on text. The rev guard, not the seq guard, decides. */
  it("keeps a newer live meter over a stale probe", () => {
    const s = run([
      { type: "meter", meter: meter({ rev: 9, outputTokens: 99 }) },
      {
        type: "probe",
        status: status({
          streaming: true,
          partial: "AB",
          seq: 4,
          meter: meter({ rev: 3, outputTokens: 3 }),
        }),
      },
    ]);
    expect(s.liveText).toBe("AB");
    expect(s.meter?.rev).toBe(9);
  });

  it("hands the turn's meter to the row it settled into", () => {
    const s = run([
      { type: "meter", meter: meter({ rev: 4, outputTokens: 40 }) },
      { type: "done", message: msg({ id: "row-1" }) },
    ]);
    expect(s.meter).toBeNull();
    expect(s.activity).toEqual([]);
    expect(s.meters["row-1"]?.outputTokens).toBe(40);
  });

  it("keeps a failed turn's economics too", () => {
    const s = run([
      { type: "meter", meter: meter({ rev: 4, inputTokens: 40_000 }) },
      { type: "error", message: msg({ id: "row-err", status: "error", body: "boom" }) },
    ]);
    expect(s.meters["row-err"]?.inputTokens).toBe(40_000);
  });

  it("does not let a new turn inherit the last one's meter", () => {
    const s = run([
      { type: "meter", meter: meter({ rev: 4, outputTokens: 40 }) },
      { type: "done", message: msg({ id: "row-1" }) },
      { type: "send-optimistic", message: msg({ id: "u1", role: "user", body: "next" }) },
    ]);
    expect(s.meter).toBeNull();
    expect(s.meters["row-1"]?.outputTokens).toBe(40);
  });

  it("does not let a DRAINED queued send inherit it either", () => {
    const s = run([
      { type: "meter", meter: meter({ rev: 4, outputTokens: 40 }) },
      { type: "queue-advanced", messageId: "q1" },
    ]);
    expect(s.meter).toBeNull();
  });

  it("lets stored meters seed the settled rows without clobbering live ones", () => {
    const s = run([
      { type: "meter", meter: meter({ rev: 4, outputTokens: 40 }) },
      { type: "done", message: msg({ id: "row-1" }) },
      { type: "meters", rows: { "row-1": meter({ rev: 1, outputTokens: 1 }), old: meter({ rev: 1 }) } },
    ]);
    // The live terminal meter is the newer truth for a row we just settled.
    expect(s.meters["row-1"]?.outputTokens).toBe(40);
    expect(s.meters.old).toBeDefined();
  });

  it("cancelling clears the live readout (the burn is booked backend-side)", () => {
    const s = run([
      { type: "meter", meter: meter({ rev: 4, outputTokens: 40 }) },
      { type: "cancelled" },
    ]);
    expect(s.meter).toBeNull();
    expect(s.activity).toEqual([]);
  });
});
