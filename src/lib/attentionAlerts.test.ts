// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  badgeCount,
  chatNews,
  isVisible,
  markSeen,
  notifyDelay,
  onePerSession,
  planNews,
  PLAN_NOTIFY_DELAY_MS,
  revealOnReturn,
  shouldNotify,
  takeNews,
  terminalNews,
  terminalSession,
  YOUR_TURN_NOTIFY_DELAY_MS,
  type LoudTerminal,
  type PlanNewsInput,
  type SessionNews,
} from "./attentionAlerts";

const loud = (id: string, at: number, extra: Partial<LoudTerminal> = {}): LoudTerminal => ({
  id,
  state: "needs-you",
  at,
  label: `${id} 1`,
  text: null,
  ...extra,
});
const plan = (sessionId: string, extra: Partial<PlanNewsInput> = {}): PlanNewsInput => ({
  sessionId,
  label: "Auth rework",
  held: true,
  version: 1,
  receivedAt: 100,
  restored: false,
  ...extra,
});
const ALL_ON = { waiting: true, finished: true } as const;

describe("transition → notification", () => {
  it("a needs-you is waiting, a your-turn finished; titled by the session when there is one", () => {
    expect(terminalNews(loud("t1", 5, { text: "Claude needs your permission" }), null)).toEqual({
      session: "term:t1",
      key: "term:t1@5",
      kind: "waiting",
      at: 5,
      title: "t1 1 · needs you",
      body: "Claude needs your permission",
      target: { type: "terminal", terminalId: "t1" },
    });
    const turn = terminalNews(loud("t1", 6, { state: "your-turn", text: "Which key should I use?" }), { session: "plan:s1", label: "Auth rework" });
    expect(turn).toMatchObject({ session: "plan:s1", kind: "finished", title: "Auth rework · your turn", body: "Which key should I use?" });
  });

  it("says something useful when the agent said nothing", () => {
    expect(terminalNews(loud("a", 1), null).body).toBe("Its agent is waiting on you.");
    expect(terminalNews(loud("a", 1, { state: "your-turn" }), null).body).toBe("Its agent finished its turn.");
  });

  it("a held plan is waiting, one that arrived unheld finished, a restore is not news", () => {
    expect(planNews(plan("s1", { version: 2 }))).toMatchObject({
      session: "plan:s1",
      key: "plan:s1@100",
      kind: "waiting",
      title: "Auth rework",
      body: "Plan v2 ready · waiting for you",
      target: { type: "plan", sessionId: "s1" },
    });
    expect(planNews(plan("s1", { held: false }))).toMatchObject({ kind: "finished", body: "Plan v1 arrived" });
    expect(planNews(plan("s1", { restored: true }))).toBeNull();
    expect(planNews(plan("s1", { receivedAt: null }))).toBeNull();
  });

  it("approving a held plan is the same transition; a revision is a new one", () => {
    const handled = new Set<string>();
    expect(takeNews([planNews(plan("s1"))!], handled, 0)).toHaveLength(1);
    expect(takeNews([planNews(plan("s1", { held: false }))!], handled, 0)).toHaveLength(0);
    expect(takeNews([planNews(plan("s1", { receivedAt: 200, version: 2 }))!], handled, 0)).toHaveLength(1);
  });

  it("a chat's reply finished, one line of it", () => {
    const n = chatNews({ companionId: "c1", messageId: "m1", at: 9, title: "Pricing", body: "Short answer:\n\n  yes." });
    expect(n).toMatchObject({ session: "chat:c1", key: "chat:c1@m1", kind: "finished", title: "Pricing · replied", body: "Short answer: yes." });
    expect(chatNews({ companionId: "c1", messageId: "m2", at: 9, title: null, body: "x".repeat(400) }).body).toHaveLength(160);
  });

  it("one notification per transition, ever: a repeat key is the same transition", () => {
    const handled = new Set<string>();
    const a = terminalNews(loud("a", 1), null);
    const b = terminalNews(loud("b", 2), null);
    expect(takeNews([a], handled, 0)).toEqual([a]);
    expect(takeNews([a, b], handled, 0)).toEqual([b]);
    // A new card on the same terminal is a new transition.
    expect(takeNews([terminalNews(loud("a", 3), null), b], handled, 0)).toHaveLength(1);
  });

  it("what happened before the window armed is handled, never news", () => {
    const handled = new Set<string>();
    expect(takeNews([terminalNews(loud("a", 10), null), planNews(plan("s1", { receivedAt: 20 }))!], handled, 50)).toEqual([]);
    expect(handled.size).toBe(2);
  });

  it("forgets a handled transition once it is no longer current", () => {
    const handled = new Set(["term:a@1", "term:b@2"]);
    takeNews([terminalNews(loud("b", 2), null)], handled, 0);
    expect([...handled]).toEqual(["term:b@2"]);
  });

  it("one notification per session per batch: waiting outranks finished", () => {
    const turn = terminalNews(loud("t1", 5, { state: "your-turn" }), { session: "plan:s1", label: "A" });
    const held = planNews(plan("s1", { receivedAt: 4 }))!;
    const other = terminalNews(loud("t2", 6), null);
    expect(onePerSession([turn, held, other])).toEqual([held, other]);
  });

  it("notifies only when the window is away or the session is not the one shown, for the kinds turned on", () => {
    const n = terminalNews(loud("t1", 5), { session: "plan:s1", label: "A" });
    const shown = new Set(["plan:s1"]);
    expect(shouldNotify(n, { focused: true, visible: shown, prefs: ALL_ON })).toBe(false);
    expect(shouldNotify(n, { focused: false, visible: shown, prefs: ALL_ON })).toBe(true);
    expect(shouldNotify(n, { focused: true, visible: new Set(["plan:s2"]), prefs: ALL_ON })).toBe(true);
    expect(shouldNotify(n, { focused: false, visible: shown, prefs: { waiting: false, finished: true } })).toBe(false);
    const done = terminalNews(loud("t1", 6, { state: "your-turn" }), null);
    expect(shouldNotify(done, { focused: false, visible: new Set(), prefs: { waiting: true, finished: false } })).toBe(false);
    // A Home terminal is on screen when its own tile is.
    expect(isVisible(done, new Set(["term:t1"]))).toBe(true);
  });

  it("a your-turn and a plan wait a beat; a needs-you and a reply go now", () => {
    expect(notifyDelay(terminalNews(loud("t", 1, { state: "your-turn" }), null))).toBe(YOUR_TURN_NOTIFY_DELAY_MS);
    expect(notifyDelay(planNews(plan("s"))!)).toBe(PLAN_NOTIFY_DELAY_MS);
    expect(notifyDelay(terminalNews(loud("t", 1), null))).toBe(0);
    expect(notifyDelay(chatNews({ companionId: "c", messageId: "m", at: 1, title: null, body: "ok" }))).toBe(0);
  });

  it("a terminal's news is its plan session's, else its launch's, else its own", () => {
    const sessions = new Map([["t1", "s1"]]);
    expect(terminalSession("t1", sessions, "home")).toBe("plan:s1");
    expect(terminalSession("t2", sessions, "launch:L")).toBe("launch:L");
    expect(terminalSession("t3", sessions, "home")).toBeNull();
    expect(terminalSession("t4", sessions, undefined)).toBeNull();
  });
});

describe("the Dock badge", () => {
  const held = planNews(plan("s1"))!;
  const asked = terminalNews(loud("t1", 5, { text: "Claude has a question" }), { session: "plan:s1", label: "A" });
  const card = terminalNews(loud("t2", 6), null);
  const turn = terminalNews(loud("t3", 7, { state: "your-turn" }), null);
  const reply = chatNews({ companionId: "c", messageId: "m", at: 8, title: null, body: "ok" });

  it("counts sessions waiting on you, each once, and never what merely finished", () => {
    expect(badgeCount([held, asked, card, turn, reply], new Set())).toBe(2);
    expect(badgeCount([turn, reply], new Set())).toBe(0);
  });

  it("a plan arrival folds in, a session waiting twice is one", () => {
    expect(badgeCount([asked], new Set())).toBe(1);
    expect(badgeCount([asked, held], new Set())).toBe(1);
  });

  it("clears what has been seen: on screen in a window in front", () => {
    let seen: ReadonlySet<string> = new Set();
    seen = markSeen(seen, [held, card], false, new Set(["plan:s1"]));
    expect(badgeCount([held, card], seen)).toBe(2);
    seen = markSeen(seen, [held, card], true, new Set(["plan:s1"]));
    expect(badgeCount([held, card], seen)).toBe(1);
    // Seen stays seen after you look away, until the transition is over.
    seen = markSeen(seen, [held, card], true, new Set());
    expect(badgeCount([held, card], seen)).toBe(1);
    // A revision is new: badged again.
    const next = planNews(plan("s1", { receivedAt: 300, version: 2 }))!;
    seen = markSeen(seen, [next, card], true, new Set());
    expect(badgeCount([next, card], seen)).toBe(2);
    expect(seen.size).toBe(0);
  });

  it("markSeen returns the same set when nothing changed", () => {
    const seen = new Set([held.key]);
    expect(markSeen(seen, [held], true, new Set(["plan:s1"]))).toBe(seen);
  });
});

describe("one batch end to end", () => {
  it("maps a fleet's transitions to what reaches you", () => {
    const handled = new Set<string>();
    const news: SessionNews[] = [
      planNews(plan("s1", { receivedAt: 1000 }))!,
      terminalNews(loud("t9", 1001), null),
      terminalNews(loud("t1", 999, { state: "your-turn" }), { session: "plan:s1", label: "A" }),
    ];
    const out = onePerSession(takeNews(news, handled, 500)).filter((n) =>
      shouldNotify(n, { focused: true, visible: new Set(["term:t9"]), prefs: ALL_ON }));
    expect(out.map((n) => n.key)).toEqual(["plan:s1@1000"]);
  });
});

describe("the way back after a notification", () => {
  const waiting = terminalNews(loud("t1", 5), null);
  const finished = terminalNews(loud("t1", 5, { state: "your-turn" }), null);
  it("shows it only while it still waits on you and is not on screen", () => {
    expect(revealOnReturn({ key: waiting.key }, [waiting], new Set())).toBe(true);
    expect(revealOnReturn({ key: waiting.key }, [waiting], new Set([waiting.session]))).toBe(false);
    expect(revealOnReturn(null, [waiting], new Set())).toBe(false);
  });
  it("never once it finished or is gone", () => {
    expect(revealOnReturn({ key: finished.key }, [finished], new Set())).toBe(false);
    expect(revealOnReturn({ key: waiting.key }, [], new Set())).toBe(false);
  });
});
