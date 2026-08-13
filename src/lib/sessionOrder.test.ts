// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { orderSessions } from "./sessionOrder";

const list = () => [
  { sessionId: "a" },
  { sessionId: "b" },
  { sessionId: "c" },
  { sessionId: "d" },
];

describe("orderSessions", () => {
  it("moves the active session to the front, preserving relative order", () => {
    expect(orderSessions(list(), "c").map((s) => s.sessionId)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("returns the same reference when the active session is already first", () => {
    const input = list();
    expect(orderSessions(input, "a")).toBe(input);
  });

  it("returns the same reference for a null activeId", () => {
    const input = list();
    expect(orderSessions(input, null)).toBe(input);
  });

  it("returns the same reference when activeId matches no row (joined-room key)", () => {
    const input = list();
    expect(orderSessions(input, "room:xyz")).toBe(input);
  });

  it("never mutates the input array", () => {
    const input = list();
    orderSessions(input, "d");
    expect(input.map((s) => s.sessionId)).toEqual(["a", "b", "c", "d"]);
  });
});
