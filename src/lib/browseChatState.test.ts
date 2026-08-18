// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  CHAT_CLOSED,
  chatEntryFor,
  pruneChatState,
  withChatPatch,
  type ChatStateMap,
} from "./browseChatState";

const entry = (open: boolean, pill: "page" | "list", at: number) => ({
  open,
  pill,
  at,
});

describe("chatEntryFor", () => {
  it("defaults a never-opened tab to closed-on-page", () => {
    // The deliberate behavior change: switching to a tab that has never had
    // the chat open now CLOSES the panel.
    expect(chatEntryFor({}, "b1")).toBe(CHAT_CLOSED);
    expect(chatEntryFor({}, null)).toBe(CHAT_CLOSED);
  });

  it("remembers a tab's own pill", () => {
    const state: ChatStateMap = { b1: entry(true, "list", 5) };
    expect(chatEntryFor(state, "b1").pill).toBe("list");
    expect(chatEntryFor(state, "b2").open).toBe(false);
  });
});

describe("withChatPatch", () => {
  it("writes only the tab it names", () => {
    const state: ChatStateMap = { b1: entry(true, "page", 1) };
    const next = withChatPatch(state, "b2", { open: true, pill: "list" }, 9);
    expect(next.b1).toBe(state.b1);
    expect(next.b2).toEqual({ open: true, pill: "list", at: 9 });
  });

  it("returns the same map when nothing moved", () => {
    // usePersistedState writes to localStorage on every new object, so a
    // no-op click must not touch the disk.
    const state: ChatStateMap = { b1: entry(true, "list", 1) };
    expect(withChatPatch(state, "b1", { open: true }, 99)).toBe(state);
  });

  it("creates the entry for a tab it has never seen", () => {
    expect(withChatPatch({}, "b1", { pill: "list" }, 4)).toEqual({
      b1: { open: false, pill: "list", at: 4 },
    });
  });
});

describe("pruneChatState", () => {
  it("leaves a small map alone, by identity", () => {
    const state: ChatStateMap = { b1: entry(true, "page", 1) };
    expect(pruneChatState(state, ["b1"])).toBe(state);
    expect(pruneChatState(state, [])).toBe(state);
  });

  it("drops the oldest closed tabs once past the cap", () => {
    // Bounded for the life of the install is the whole point.
    const state: ChatStateMap = {};
    for (let i = 0; i < 10; i++) state[`b${i}`] = entry(true, "page", i);
    const next = pruneChatState(state, [], 3);
    expect(Object.keys(next).sort()).toEqual(["b7", "b8", "b9"]);
  });

  it("NEVER drops a tab that still exists, however stale", () => {
    const state: ChatStateMap = { old: entry(true, "list", 0) };
    for (let i = 0; i < 10; i++) state[`b${i}`] = entry(true, "page", i + 100);
    const next = pruneChatState(state, ["old"], 2);
    expect(next.old).toBe(state.old);
  });

  it("survives a mission swap without forgetting the regular tabs", () => {
    // The failure the naive 'drop anything not in `tabs`' rule would cause:
    // `tabs` is only the CURRENT workspace, so entering a mission would evict
    // every regular tab's memory and coming back would land on a closed
    // panel — the same round-trip amnesia this whole map exists to fix.
    const regular: ChatStateMap = {
      r1: entry(true, "list", 1),
      r2: entry(true, "page", 2),
    };
    // In the mission, only the mission's tabs are live.
    const inMission = pruneChatState(regular, ["m1", "m2"]);
    expect(inMission.r1).toEqual(regular.r1);
    expect(inMission.r2).toEqual(regular.r2);
  });
});
