// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  newTransitions,
  notificationFor,
  transitionKey,
  type LoudTerminal,
} from "./attentionAlerts";

const loud = (id: string, at: number, extra: Partial<LoudTerminal> = {}): LoudTerminal => ({
  id,
  state: "needs-you",
  at,
  label: `${id} 1`,
  text: null,
  ...extra,
});

describe("attention alerts", () => {
  it("one alert per terminal per transition: a repeat `at` is the same transition", () => {
    const handled = new Set([transitionKey(loud("a", 1))]);
    expect(newTransitions([loud("a", 1), loud("b", 2)], handled).map((t) => t.id)).toEqual(["b"]);
    // A new card on the same terminal is a new transition.
    expect(newTransitions([loud("a", 3)], handled)).toHaveLength(1);
  });

  it("titles the terminal by its own label and says what its agent said", () => {
    expect(notificationFor(loud("redline", 1, { text: "Claude needs your permission" }))).toEqual({
      title: "redline 1 · needs you",
      body: "Claude needs your permission",
    });
    expect(notificationFor(loud("api", 1, { state: "your-turn", text: "Which key should I use?" }))).toEqual({
      title: "api 1 · your turn",
      body: "Which key should I use?",
    });
  });

  it("says something useful when the agent said nothing", () => {
    expect(notificationFor(loud("a", 1)).body).toBe("Its agent is waiting on you.");
    expect(notificationFor(loud("a", 1, { state: "your-turn" })).body).toBe("Its agent finished its turn.");
  });
});
