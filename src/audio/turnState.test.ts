// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  IDLE_TURN,
  STILL_AFTER_MS,
  accepts,
  activityCaption,
  thinkingCaption,
  turnReducer,
  type TurnAction,
  type TurnState,
} from "./turnState";

const id = (generation: number, turn: number) => ({ generation, turn });
const run = (actions: TurnAction[], from: TurnState = IDLE_TURN) =>
  actions.reduce(turnReducer, from);

describe("turnReducer", () => {
  it("follows a turn from send to its end", () => {
    let s = run([{ type: "baseline", id: id(1, 0) }, { type: "send", at: 10 }]);
    expect(s.phase).toBe("sending");
    s = turnReducer(s, { type: "sent", id: id(1, 1) });
    expect(s).toMatchObject({ phase: "thinking", live: id(1, 1), since: 10 });
    s = turnReducer(s, { type: "text", id: id(1, 1) });
    expect(s.phase).toBe("streaming");
    s = turnReducer(s, { type: "end", id: id(1, 1) });
    expect(s).toEqual({ ...IDLE_TURN, settled: id(1, 1) });
  });

  it("acts only on the live turn: another child's or an earlier turn's events are ignored", () => {
    const s = run([{ type: "send", at: 0 }, { type: "sent", id: id(2, 3) }]);
    expect(accepts(s, id(2, 3))).toBe(true);
    expect(accepts(s, id(2, 2))).toBe(false);
    expect(accepts(s, id(1, 3))).toBe(false);
    expect(turnReducer(s, { type: "end", id: id(2, 2) })).toBe(s);
    expect(turnReducer(s, { type: "text", id: id(1, 3) })).toBe(s);
  });

  it("before voice_send answers, takes the first turn newer than the last one that ended", () => {
    let s = run([{ type: "baseline", id: id(4, 7) }, { type: "send", at: 0 }]);
    expect(accepts(s, id(4, 7))).toBe(false);
    expect(accepts(s, id(4, 8))).toBe(true);
    // A replacement child counts its turns from one again — still newer.
    expect(accepts(s, id(5, 1))).toBe(true);
    s = turnReducer(s, { type: "text", id: id(4, 8) });
    expect(s.live).toEqual(id(4, 8));
  });

  it("ignores voice_send's answer for a turn that has already ended", () => {
    const s = run([
      { type: "send", at: 0 },
      { type: "text", id: id(1, 1) },
      { type: "end", id: id(1, 1) },
    ]);
    expect(turnReducer(s, { type: "sent", id: id(1, 1) })).toBe(s);
  });

  it("does not re-render a turn that is already streaming", () => {
    const s = run([{ type: "send", at: 0 }, { type: "sent", id: id(1, 1) }, { type: "text", id: id(1, 1) }]);
    expect(turnReducer(s, { type: "text", id: id(1, 1) })).toBe(s);
  });

  it("adopts a turn it did not send, and loses one whose child went away", () => {
    let s = turnReducer(IDLE_TURN, { type: "adopt", id: id(3, 2), at: 5 });
    expect(s).toMatchObject({ phase: "thinking", live: id(3, 2) });
    expect(turnReducer(s, { type: "lost", generation: 2 })).toBe(s);
    s = turnReducer(s, { type: "lost", generation: 3 });
    expect(s).toEqual({ ...IDLE_TURN, settled: id(3, 2) });
  });

  it("keeps the latest activity, and marks a stop as on its way", () => {
    const tool = { at: 1, kind: "tool", label: "Bash…" };
    let s = run([{ type: "send", at: 0 }, { type: "sent", id: id(1, 1) }]);
    s = turnReducer(s, { type: "activity", id: id(1, 1), activity: tool });
    expect(s.activity).toBe(tool);
    expect(turnReducer(s, { type: "activity", id: id(1, 1), activity: null })).toBe(s);
    s = turnReducer(s, { type: "interrupt" });
    expect(s.interrupting).toBe(true);
    expect(turnReducer(IDLE_TURN, { type: "interrupt" })).toBe(IDLE_TURN);
  });

  it("returns to idle when a send fails", () => {
    const s = run([{ type: "baseline", id: id(1, 4) }, { type: "send", at: 0 }, { type: "send-failed" }]);
    expect(s).toEqual({ ...IDLE_TURN, settled: id(1, 4) });
  });
});

describe("captions", () => {
  it("says what the agent is doing in words for someone waiting", () => {
    expect(activityCaption(null)).toBe("Thinking…");
    expect(activityCaption({ at: 0, kind: "requesting", label: "Requesting…" })).toBe("Thinking…");
    expect(activityCaption({ at: 0, kind: "thinking", label: "Thinking…" })).toBe("Thinking it through…");
    expect(activityCaption({ at: 0, kind: "tool", label: "Bash…" })).toBe("Reading the plan…");
    expect(activityCaption({ at: 0, kind: "tool", label: "Grep…" })).toBe("Searching the code…");
    expect(activityCaption({ at: 0, kind: "tool", label: "searching your memory…" })).toBe(
      "Searching your memory…",
    );
  });

  it("says it is still going at 12 s", () => {
    const tool = { at: 0, kind: "tool", label: "Bash…" };
    expect(thinkingCaption(tool, STILL_AFTER_MS - 1)).toBe("Reading the plan…");
    expect(thinkingCaption(tool, STILL_AFTER_MS)).toBe("Still reading the plan…");
    expect(thinkingCaption(null, 45_000)).toBe("Still thinking…");
  });

  it("leaves a rate limit's own words alone", () => {
    const limited = { at: 0, kind: "rateLimit", label: "Rate limited (five_hour) · waiting" };
    expect(thinkingCaption(limited, 45_000)).toBe("Rate limited (five_hour) · waiting");
  });
});
