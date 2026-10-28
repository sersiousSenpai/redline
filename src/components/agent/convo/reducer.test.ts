// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { ConvoAsk, ConvoEvent } from "./types";
import {
  MAX_ROWS,
  convoReducer,
  convoView,
  initialConvoState,
  normalizeSendText,
  type ConvoAction,
  type ConvoState,
  type Turn,
} from "./reducer";
import { actionEvents, fixtureActions, isConvoEvent, loadConvoFixture, loadConvoFixtures, replay } from "./__fixtures__/loadFixtures";

type Body = ConvoEvent extends infer E ? (E extends ConvoEvent ? Omit<E, "id" | "epoch" | "offset" | "ts"> : never) : never;

/** One event at `offset` (epoch 0 unless given), `ts` = offset ms. */
function ev(id: string, offset: number, body: Body, epoch = 0, ts = offset): ConvoEvent {
  return { id, epoch, offset, ts, ...body } as ConvoEvent;
}
const batch = (...events: ConvoEvent[]): ConvoAction => ({ type: "batch", batch: { events } });
const run = (...actions: ConvoAction[]) => replay(actions);
const ids = (state: ConvoState) => state.events.map((e) => e.id);
const turns = (state: ConvoState): Turn[] =>
  convoView(state).blocks.flatMap((b) => (b.kind === "turn" ? [b.turn] : []));

describe("merge: keyed upsert, ordered by (epoch, offset)", () => {
  const a = ev("a", 10, { kind: "user_text", text: "hi" });
  const b = ev("b", 20, { kind: "assistant_text", text: "hello" });
  const c = ev("c", 30, { kind: "turn_end" });

  it("the same batch twice hands back the same state object", () => {
    const once = run(batch(a, b, c));
    expect(convoReducer(once, batch(a, b, c))).toBe(once);
  });

  it.each([
    ["in order", [a, b, c]],
    ["reversed", [c, b, a]],
    ["shuffled", [b, c, a]],
  ])("arrival %s still reads in key order", (_label, events) => {
    expect(ids(run(batch(...events)))).toEqual(["a", "b", "c"]);
  });

  it("an epoch outranks any offset", () => {
    const late = ev("z", 5, { kind: "user_text", text: "after clear" }, 1);
    expect(ids(run(batch(late, c, a)))).toEqual(["a", "c", "z"]);
  });

  it("events sharing an offset keep the order they were first seen in", () => {
    const one = ev("l:0", 50, { kind: "model_seen", model: "m" });
    const two = ev("l:1", 50, { kind: "thinking" });
    expect(ids(run(batch(one, two)))).toEqual(["l:0", "l:1"]);
    expect(ids(run(batch(two), batch(one)))).toEqual(["l:1", "l:0"]);
    // A re-read keeps the first-sight order rather than re-ranking.
    expect(ids(run(batch(one, two), batch(two, one)))).toEqual(["l:0", "l:1"]);
  });

  it("a changed event replaces its earlier read in place", () => {
    const edited = ev("b", 20, { kind: "assistant_text", text: "hello again" });
    const state = run(batch(a, b, c), batch(edited));
    expect(ids(state)).toEqual(["a", "b", "c"]);
    expect(state.events[1]).toEqual(edited);
  });

  it("reset drops what is held and takes the batch as the new tail", () => {
    const fresh = ev("x", 1, { kind: "user_text", text: "other session" });
    const state = run(batch(a, b, c), { type: "batch", batch: { events: [fresh], reset: true } });
    expect(ids(state)).toEqual(["x"]);
  });

  it("a snapshot merges with a batch that beat it onto the channel", () => {
    const state = run(batch(c), { type: "snapshot", snapshot: { subscriptionId: "s", events: [a, b], hasOlder: true } });
    expect(ids(state)).toEqual(["a", "b", "c"]);
    expect(state.hasOlder).toBe(true);
  });

  it("an older page lands in front and sets hasOlder from the page", () => {
    const early = ev("e", 1, { kind: "user_text", text: "first" });
    const state = run(
      { type: "snapshot", snapshot: { subscriptionId: "s", events: [b, c], hasOlder: true } },
      { type: "page", page: { events: [early, a], hasOlder: false } },
    );
    expect(ids(state)).toEqual(["e", "a", "b", "c"]);
    expect(state.hasOlder).toBe(false);
    expect(convoView(state).oldest).toEqual({ epoch: 0, offset: 1 });
  });

  it("pages back from the tail's first line, not the binding that heads it", () => {
    const bound = ev("bound", 0, { kind: "bound", harness: "claude", sessionId: "s1", transcriptPath: null, source: "startup" });
    const state = run({ type: "snapshot", snapshot: { subscriptionId: "s", events: [bound, b, c], hasOlder: true } });
    expect(convoView(state).oldest).toEqual({ epoch: 0, offset: 20 });
  });
});

describe("turns", () => {
  it("the plan turn: a prompt, its reads, its narration, its plan, then a question", () => {
    const state = replay(loadConvoFixture("plan-turn").actions);
    const view = convoView(state);
    const [plan, question] = view.blocks.flatMap((b) => (b.kind === "turn" ? [b.turn] : []));
    expect(plan.user?.text).toBe("Read the obsidian build log and plan the next roadmap steps");
    expect(plan.items.map((item) => item.kind)).toEqual(["thinking", "tool", "tool", "tool", "tool", "prose", "tool", "plan"]);
    expect(plan.items.filter((item) => item.kind === "tool").every((item) => item.kind === "tool" && (item.status === "done" || item.name === "ExitPlanMode"))).toBe(true);
    expect(plan).toMatchObject({ ended: true, interrupted: false, durationMs: 124000 });
    expect(question.user?.text).toBe("Why is Xcode compile first?");
    expect(question.items.map((item) => item.kind)).toEqual(["prose"]);
    expect(view.activeTurn).toBeNull();
    expect(view.lastTurn).toBe(question);
    expect(view.plan).toMatchObject({ toolUseId: "toolu_05", sessionId: "sess-din-1", title: "Din roadmap: next steps", outcome: null });
    expect(view.mode).toBe("plan");
    expect(view.model).toEqual({ model: "claude-opus-4-5-20251101", effort: "high" });
    expect(view.bound).toMatchObject({ harness: "claude", sessionId: "sess-din-1" });
  });

  it("mid-flight: the turn is active and its tools have their results", () => {
    const view = convoView(replay(loadConvoFixture("plan-live").actions));
    expect(view.activeTurn?.ended).toBe(false);
    expect(view.activeTurn?.items.filter((item) => item.kind === "tool")).toHaveLength(4);
    expect(view.activeTurn?.startedAt).toBe(1760774401000);
  });

  it.each([
    ["a tool still running", [ev("u", 1, { kind: "user_text", text: "go" }), ev("t", 2, { kind: "tool_use", toolUseId: "t1", name: "Bash", summary: "ls" })], "running"],
    ["a result", [ev("u", 1, { kind: "user_text", text: "go" }), ev("t", 2, { kind: "tool_use", toolUseId: "t1", name: "Bash", summary: "ls" }), ev("r", 3, { kind: "tool_result", toolUseId: "t1", isError: false, preview: "a b" })], "done"],
    ["an error result", [ev("u", 1, { kind: "user_text", text: "go" }), ev("t", 2, { kind: "tool_use", toolUseId: "t1", name: "Bash", summary: "ls" }), ev("r", 3, { kind: "tool_result", toolUseId: "t1", isError: true, preview: "no" })], "error"],
  ])("a tool with %s reads %s", (_label, events, status) => {
    const [turn] = turns(run(batch(...(events as ConvoEvent[]))));
    expect(turn.items.find((item) => item.kind === "tool")).toMatchObject({ status });
  });

  it("events before any prompt open a turn with no bubble", () => {
    const [turn] = turns(run(batch(ev("a", 5, { kind: "assistant_text", text: "continuing" }))));
    expect(turn.user).toBeNull();
    expect(turn.ended).toBe(false);
  });

  it("a new prompt ends the turn before it, from its last event", () => {
    const [first, second] = turns(
      run(batch(ev("u1", 1, { kind: "user_text", text: "a" }, 0, 1000), ev("x", 2, { kind: "assistant_text", text: "b" }, 0, 4000), ev("u2", 3, { kind: "user_text", text: "c" }, 0, 9000))),
    );
    expect(first).toMatchObject({ ended: true, endedAt: 4000, durationMs: 3000 });
    expect(second.ended).toBe(false);
  });

  it("a run of thinking blocks is one mark; empty prose draws nothing", () => {
    const [turn] = turns(
      run(batch(ev("u", 1, { kind: "user_text", text: "a" }), ev("t1", 2, { kind: "thinking" }), ev("t2", 3, { kind: "thinking" }), ev("p", 4, { kind: "assistant_text", text: "  " }))),
    );
    expect(turn.items.map((item) => item.kind)).toEqual(["thinking"]);
  });

  it("clear, compact and interrupt: a divider, a marker inside the turn, and a stopped turn", () => {
    const view = convoView(replay(loadConvoFixture("clear-compact").actions));
    expect(view.blocks.map((b) => b.kind)).toEqual(["turn", "epoch", "turn"]);
    const [stopped] = turns(replay(loadConvoFixture("clear-compact").actions));
    expect(stopped.items.map((item) => item.kind)).toEqual(["tool", "prose", "compact", "tool"]);
    expect(stopped).toMatchObject({ ended: true, interrupted: true, durationMs: 8000 });
    expect(view.bound?.sessionId).toBe("sess-b");
    expect(view.mode).toBe("default");
    expect(view.lastTurn?.durationMs).toBe(2100);
  });

  it("a compact between turns is a block of its own", () => {
    const view = convoView(run(batch(ev("u", 1, { kind: "user_text", text: "a" }), ev("e", 2, { kind: "turn_end" }), ev("c", 3, { kind: "compact", trigger: "manual" }))));
    expect(view.blocks.map((b) => b.kind)).toEqual(["turn", "compact"]);
  });
});

describe("optimistic sends", () => {
  const expect_ = (nonce: string, text: string, at = 1000): ConvoAction => ({ type: "expect", nonce, text, at });
  const pending = (state: ConvoState) => convoView(state).pending.map((b) => [b.text, b.delivery]);

  it.each<[string, ConvoAction[], [string, string][]]>([
    ["shows at once", [expect_("n1", "hello")], [["hello", "pending"]]],
    ["moves to delivered", [expect_("n1", "hello"), batch(ev("d", 5, { kind: "delivered", nonce: "n1", promptId: "p1" }))], [["hello", "delivered"]]],
    ["moves to undelivered", [expect_("n1", "hello"), batch(ev("d", 5, { kind: "undelivered", nonce: "n1" }))], [["hello", "undelivered"]]],
    [
      "a late delivered beats undelivered",
      [expect_("n1", "hello"), batch(ev("d", 5, { kind: "undelivered", nonce: "n1" })), batch(ev("e", 6, { kind: "delivered", nonce: "n1" }))],
      [["hello", "delivered"]],
    ],
    [
      "undelivered after delivered changes nothing",
      [expect_("n1", "hello"), batch(ev("e", 6, { kind: "delivered", nonce: "n1" })), batch(ev("d", 7, { kind: "undelivered", nonce: "n1" }))],
      [["hello", "delivered"]],
    ],
    ["absorbed by its prompt id", [expect_("n1", "hello"), batch(ev("d", 5, { kind: "delivered", nonce: "n1", promptId: "p1" }), ev("u", 4, { kind: "user_text", text: "HELLO (edited by a hook)", promptId: "p1" }, 0, 900))], []],
    ["absorbed by its text", [expect_("n1", "fix  the\r\nbug"), batch(ev("u", 4, { kind: "user_text", text: "fix the bug" }, 0, 1500))], []],
    ["not by an older prompt with the same text", [batch(ev("u", 4, { kind: "user_text", text: "yes" }, 0, 100)), expect_("n1", "yes", 60_000)], [["yes", "pending"]]],
    ["retracted when it never reached the PTY", [expect_("n1", "hello"), { type: "retract", nonce: "n1" }], []],
    ["the same nonce twice is one bubble", [expect_("n1", "hello"), expect_("n1", "hello")], [["hello", "pending"]]],
  ])("a send %s", (_label, actions, expected) => {
    expect(pending(run(...actions))).toEqual(expected);
  });

  it("two identical sends are absorbed by two prompts, one each", () => {
    const state = run(
      expect_("n1", "yes", 1000),
      expect_("n2", "yes", 2000),
      batch(ev("u1", 10, { kind: "user_text", text: "yes" }, 0, 1100)),
    );
    expect(pending(state)).toEqual([["yes", "pending"]]);
    const both = convoReducer(state, batch(ev("u2", 20, { kind: "user_text", text: "yes" }, 0, 2100)));
    expect(pending(both)).toEqual([]);
    expect(turns(both).map((t) => t.user?.nonce)).toEqual(["n1", "n2"]);
  });

  it("the transcript's bubble remembers the send it absorbed", () => {
    const state = run(expect_("n1", "hi"), batch(ev("u", 3, { kind: "user_text", text: "hi" }, 0, 1000)));
    expect(turns(state)[0].user).toMatchObject({ id: "u", delivery: "sent", nonce: "n1" });
  });

  it("normalizes what the PTY strips", () => {
    expect(normalizeSendText(" a\u0007b\r\n\tc  ")).toBe("ab c");
  });
});

describe("facts outlive their rows", () => {
  it("an older event never rolls the mode back", () => {
    const state = run(
      { type: "snapshot", snapshot: { subscriptionId: "s", events: [ev("m2", 50, { kind: "mode_change", mode: "plan" })], hasOlder: true } },
      { type: "page", page: { events: [ev("m1", 10, { kind: "mode_change", mode: "default" })], hasOlder: false } },
    );
    expect(convoView(state).mode).toBe("plan");
  });

  it.each([
    ["readiness", [ev("r1", 1, { kind: "readiness", ready: false, blocker: "unbound" }), ev("r2", 2, { kind: "readiness", ready: true, blocker: null })], { ready: true, blocker: null }],
    ["readiness (reversed)", [ev("r2", 2, { kind: "readiness", ready: true, blocker: null }), ev("r1", 1, { kind: "readiness", ready: false, blocker: "unbound" })], { ready: true, blocker: null }],
  ])("%s: the newest by key wins", (_label, events, expected) => {
    expect(convoView(run(batch(...(events as ConvoEvent[])))).readiness).toEqual(expected);
  });

  it("model_seen without an effort reads as null", () => {
    expect(convoView(run(batch(ev("m", 1, { kind: "model_seen", model: "gpt-5.1-codex" })))).model).toEqual({ model: "gpt-5.1-codex", effort: null });
  });
});

describe("asks", () => {
  const ask = (askId: string): ConvoAsk => ({ askId, kind: "permission", toolName: "Bash", summary: "npm test", openedAt: 1 });

  it("the fixture: a permission answered, a question still open", () => {
    const view = convoView(replay(loadConvoFixture("asks").actions));
    expect(view.openAsks.map((a) => a.askId)).toEqual(["ask-2"]);
    const items = view.lastTurn!.items.filter((item) => item.kind === "ask");
    expect(items.map((item) => item.kind === "ask" && [item.ask.askId, item.outcome])).toEqual([["ask-1", "allow"], ["ask-2", null]]);
  });

  it.each([
    ["opened", [ev("o", 1, { kind: "ask_opened", ask: ask("a1") })], ["a1"]],
    ["opened then closed", [ev("o", 1, { kind: "ask_opened", ask: ask("a1") }), ev("c", 2, { kind: "ask_closed", askId: "a1", outcome: "deny" })], []],
    ["closed before its open arrives", [ev("c", 2, { kind: "ask_closed", askId: "a1", outcome: "expired" }), ev("o", 1, { kind: "ask_opened", ask: ask("a1") })], []],
    ["two open, oldest first", [ev("o2", 5, { kind: "ask_opened", ask: ask("a2") }), ev("o1", 1, { kind: "ask_opened", ask: ask("a1") })], ["a1", "a2"]],
  ])("%s", (_label, events, open) => {
    expect(convoView(run(batch(...(events as ConvoEvent[])))).openAsks.map((a) => a.askId)).toEqual(open);
  });
});

describe("plans", () => {
  const proposed = (id: string, offset: number, tool: string, title: string) =>
    ev(id, offset, { kind: "plan_proposed", toolUseId: tool, sessionId: "s1", title });

  it.each([
    ["the latest proposal is the plan", [proposed("p1", 1, "t1", "v1"), proposed("p2", 9, "t2", "v2")], { toolUseId: "t2", title: "v2", outcome: null }],
    ["its outcome attaches", [proposed("p1", 1, "t1", "v1"), ev("o", 2, { kind: "plan_outcome", toolUseId: "t1", outcome: "feedback", feedback: "2 marks" })], { toolUseId: "t1", outcome: "feedback", feedback: "2 marks" }],
    ["an outcome before its proposal still attaches", [ev("o", 2, { kind: "plan_outcome", toolUseId: "t1", outcome: "approved" }), proposed("p1", 1, "t1", "v1")], { toolUseId: "t1", title: "v1", outcome: "approved" }],
  ])("%s", (_label, events, expected) => {
    expect(convoView(run(batch(...(events as ConvoEvent[])))).plan).toMatchObject(expected);
  });

  it("an outcome with no proposal is not a plan", () => {
    expect(convoView(run(batch(ev("o", 2, { kind: "plan_outcome", toolUseId: "t1", outcome: "denied" })))).plan).toBeNull();
  });
});

describe("the CLI's own queue", () => {
  it("enqueue, remove and dequeue, in order", () => {
    const view = convoView(replay(loadConvoFixture("queue").actions));
    expect(view.queue).toEqual(["never mind the docs"]);
    expect(view.readiness).toEqual({ ready: false, blocker: "native_dialog" });
  });

  it.each([
    ["popAll clears it", [ev("a", 1, { kind: "queued", op: "enqueue", text: "x" }), ev("b", 2, { kind: "queued", op: "popAll" })], []],
    ["a dequeue on an empty queue is nothing", [ev("b", 2, { kind: "queued", op: "dequeue" })], []],
    ["an epoch clears it", [ev("a", 1, { kind: "queued", op: "enqueue", text: "x" }), ev("e", 0, { kind: "epoch", reason: "clear" }, 1)], []],
  ])("%s", (_label, events, queue) => {
    expect(convoView(run(batch(...(events as ConvoEvent[])))).queue).toEqual(queue);
  });
});

describe("the cap", () => {
  /** `n` one-row turns: a prompt and a reply each. */
  function rows(n: number, from = 0): ConvoEvent[] {
    const out: ConvoEvent[] = [];
    for (let i = from; i < from + n; i++)
      out.push(ev(`r${i}`, i * 10, i % 2 ? { kind: "assistant_text", text: `reply ${i}` } : { kind: "user_text", text: `prompt ${i}` }));
    return out;
  }

  it(`keeps the newest ${MAX_ROWS} rows while following the live end`, () => {
    const state = run(batch(...rows(MAX_ROWS + 50)));
    expect(state.events).toHaveLength(MAX_ROWS);
    expect(state.events[0].id).toBe("r50");
    expect(state.hasOlder).toBe(true);
  });

  it("paged rows stay until the reader is back at the bottom", () => {
    const live = run(batch(...rows(MAX_ROWS + 50)));
    const paged = convoReducer(live, { type: "page", page: { events: rows(50), hasOlder: false } });
    expect(paged.events).toHaveLength(MAX_ROWS + 50);
    // A live row arriving while scrolled up keeps the paged window.
    const more = convoReducer(paged, batch(...rows(2, MAX_ROWS + 50)));
    expect(more.events).toHaveLength(MAX_ROWS + 52);
    const trimmed = convoReducer(more, { type: "trim" });
    expect(trimmed.events).toHaveLength(MAX_ROWS);
    expect(trimmed.hasOlder).toBe(true);
    expect(convoReducer(trimmed, { type: "trim" })).toBe(trimmed);
  });

  it("an open ask and the latest plan survive their rows falling off", () => {
    const opened = ev("ask", 0, { kind: "ask_opened", ask: { askId: "a1", kind: "permission", toolName: "Bash", summary: "x", openedAt: 0 } });
    const plan = ev("plan", 1, { kind: "plan_proposed", toolUseId: "t1", sessionId: "s1", title: "Kept" });
    const state = run(batch(opened, plan, ...rows(MAX_ROWS + 10, 1)));
    expect(ids(state)).not.toContain("ask");
    const view = convoView(state);
    expect(view.openAsks.map((a) => a.askId)).toEqual(["a1"]);
    expect(view.plan?.title).toBe("Kept");
  });

  it("non-row events don't count toward it", () => {
    const noise = Array.from({ length: 500 }, (_, i) => ev(`n${i}`, i, { kind: "readiness", ready: i % 2 === 0, blocker: null }));
    expect(run(batch(...noise)).events).toHaveLength(500);
  });
});

describe("every fixture, hand-made and golden", () => {
  const fixtures = loadConvoFixtures();

  it("finds the hand-made set", () => {
    expect(fixtures.filter((f) => f.source === "hand").map((f) => f.name)).toEqual(
      expect.arrayContaining(["asks", "clear-compact", "plan-live", "plan-turn", "queue"]),
    );
  });

  for (const fixture of fixtures) {
    describe(`${fixture.source}: ${fixture.name}`, () => {
      it("follows types.ts: every event has its base and a declared kind, and ids are unique", () => {
        expect(fixture.events.every(isConvoEvent)).toBe(true);
        expect(new Set(fixture.events.map((e) => e.id)).size).toBe(fixture.events.length);
      });

      it("replays idempotently", () => {
        const once = replay(fixture.actions);
        expect(replay(fixture.actions, once)).toBe(once);
      });

      it("reads the same one event at a time", () => {
        const whole = convoView(replay(fixture.actions));
        const single = convoView(replay(fixture.events.map((e) => batch(e))));
        expect(single).toEqual(whole);
      });

      it("reads the same with its offsets delivered in reverse", () => {
        // Chunked at offset boundaries, so events sharing an offset still
        // arrive together and keep their first-sight order.
        const sorted = [...fixture.events].sort((a, b) => a.epoch - b.epoch || a.offset - b.offset);
        const chunks: ConvoEvent[][] = [];
        for (const e of sorted) {
          const last = chunks[chunks.length - 1];
          if (last && last[0].epoch === e.epoch && last[0].offset === e.offset) last.push(e);
          else chunks.push([e]);
        }
        const forward = convoView(replay(chunks.map((c) => batch(...c))));
        const backward = convoView(replay([...chunks].reverse().map((c) => batch(...c))));
        expect(backward).toEqual(forward);
      });
    });
  }
});

describe("the fixture loader", () => {
  const e = ev("a", 1, { kind: "thinking" });
  it.each<[string, unknown, string[]]>([
    ["an event array", [e], ["batch"]],
    ["a batch array", [{ events: [e] }, { events: [], reset: true }], ["batch", "batch"]],
    ["one batch", { events: [e], reset: true }, ["batch"]],
    ["a subscription", { snapshot: { events: [e], hasOlder: true }, batches: [{ events: [] }], pages: [{ events: [], hasOlder: false }], expected: {} }, ["snapshot", "batch", "page"]],
  ])("reads %s", (_label, json, kinds) => {
    const actions = fixtureActions(json);
    expect(actions.map((a) => a.type)).toEqual(kinds);
    expect(actionEvents(actions)).toEqual([e]);
  });

  it("refuses what it can't read", () => {
    expect(() => fixtureActions({ nope: 1 })).toThrow();
    expect(() => fixtureActions([e, { events: [] }])).toThrow();
  });

  it("starts from an empty state", () => {
    expect(convoView(initialConvoState())).toMatchObject({ blocks: [], pending: [], activeTurn: null, plan: null, hasOlder: false, oldest: null });
  });
});

describe("the outbox (W2's work drawer)", () => {
  it("the latest outbox is the drawer; a send it hands on is an optimistic bubble until the prompt absorbs it", () => {
    const items = (...texts: string[]) => texts.map((text, i) => ({ id: `n${i}`, text, at: 0 }));
    let state = run(batch(ev("o1", 10, { kind: "outbox", items: items("first", "second") })));
    expect(convoView(state).outbox.map((i) => i.text)).toEqual(["first", "second"]);
    state = convoReducer(state, batch(ev("o2", 10, { kind: "outbox", items: items("second") }), ev("s", 10, { kind: "sending", nonce: "n0", text: "first" }, 0, 100)));
    expect(convoView(state).outbox.map((i) => i.text)).toEqual(["second"]);
    expect(convoView(state).pending.map((b) => [b.text, b.delivery])).toEqual([["first", "pending"]]);
    state = convoReducer(state, batch(ev("d", 10, { kind: "delivered", nonce: "n0" }), ev("u", 20, { kind: "user_text", text: "first" }, 0, 101)));
    expect(convoView(state).pending).toEqual([]);
    // An older outbox never rolls the drawer back.
    state = convoReducer(state, { type: "page", page: { events: [ev("o0", 5, { kind: "outbox", items: items("stale") })], hasOlder: false } });
    expect(convoView(state).outbox.map((i) => i.text)).toEqual(["second"]);
  });
});
