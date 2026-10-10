// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { keepEqual, keepEqualRows } from "./keepEqual";

const session = (id: string, comments: { id: string; body: string }[]) => ({
  sessionId: id,
  revisions: [
    { versionNumber: 1, sections: [{ anchorId: "a", text: "Intro" }], comments: [] },
    { versionNumber: 2, sections: [{ anchorId: "a", text: "Intro" }], comments },
  ],
});

describe("keepEqual", () => {
  it("hands back the previous value itself when a fresh read equals it", () => {
    const prev = session("s1", [{ id: "c1", body: "Why?" }]);
    const next = session("s1", [{ id: "c1", body: "Why?" }]);
    expect(keepEqual(prev, next)).toBe(prev);
  });

  it("keeps every unchanged part when one comment changed", () => {
    const prev = session("s1", [{ id: "c1", body: "Why?" }, { id: "c2", body: "Ok" }]);
    const next = session("s1", [{ id: "c1", body: "Why not?" }, { id: "c2", body: "Ok" }]);
    const kept = keepEqual(prev, next);
    expect(kept).not.toBe(prev);
    expect(kept).toEqual(next);
    expect(kept.revisions[0]).toBe(prev.revisions[0]);
    expect(kept.revisions[1].sections).toBe(prev.revisions[1].sections);
    expect(kept.revisions[1].comments[1]).toBe(prev.revisions[1].comments[1]);
    expect(kept.revisions[1].comments[0]).not.toBe(prev.revisions[1].comments[0]);
  });

  it("sees added, removed and renamed keys and changed lengths", () => {
    const prev: Record<string, number | undefined> = { a: 1, b: undefined };
    expect(keepEqual(prev, { a: 1, c: undefined })).not.toBe(prev);
    expect(keepEqual(prev, { a: 1 })).not.toBe(prev);
    const list = [1, 2, 3];
    expect(keepEqual(list, [1, 2])).toEqual([1, 2]);
    expect(keepEqual(list, [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  it("compares Sets and Maps by membership", () => {
    const set = new Set(["a", "b"]);
    expect(keepEqual(set, new Set(["b", "a"]))).toBe(set);
    expect(keepEqual(set, new Set(["a"]))).not.toBe(set);
    const map = new Map([["t1", "Plan A"]]);
    expect(keepEqual(map, new Map([["t1", "Plan A"]]))).toBe(map);
    expect(keepEqual(map, new Map([["t1", "Plan B"]]))).not.toBe(map);
  });

  it("never merges across kinds", () => {
    const arr = [1];
    expect(keepEqual<unknown>(arr, { 0: 1 })).toEqual({ 0: 1 });
    expect(keepEqual<unknown>(null, {})).toEqual({});
    expect(keepEqual<unknown>({}, null)).toBe(null);
    expect(keepEqual<unknown>(new Set([1]), [1])).toEqual([1]);
  });

  describe("keepEqualRows", () => {
    const row = (sessionId: string, updatedAt: number, pendingCount = 0) => ({ sessionId, updatedAt, pendingCount });
    const byId = (s: { sessionId: string }) => s.sessionId;

    it("hands back the previous list when a read changed nothing", () => {
      const prev = [row("a", 3), row("b", 2), row("c", 1)];
      expect(keepEqualRows(prev, [row("a", 3), row("b", 2), row("c", 1)], byId)).toBe(prev);
    });

    it("keeps every untouched row when a bumped session re-sorts to the top", () => {
      const prev = [row("a", 3), row("b", 2), row("c", 1)];
      const kept = keepEqualRows(prev, [row("c", 4, 1), row("a", 3), row("b", 2)], byId);
      expect(kept).toEqual([row("c", 4, 1), row("a", 3), row("b", 2)]);
      expect(kept[1]).toBe(prev[0]);
      expect(kept[2]).toBe(prev[1]);
      expect(kept[0]).not.toBe(prev[2]);
    });

    it("sees a change that moved no timestamp, and rows that came and went", () => {
      const prev = [row("a", 3), row("b", 2)];
      // `held` and the pending count change without bumping updatedAt.
      const held = keepEqualRows(prev, [row("a", 3, 2), row("b", 2)], byId);
      expect(held[0].pendingCount).toBe(2);
      expect(held[1]).toBe(prev[1]);
      const fewer = keepEqualRows(prev, [row("b", 2)], byId);
      expect(fewer).toEqual([row("b", 2)]);
      expect(fewer[0]).toBe(prev[1]);
      const more = keepEqualRows(prev, [row("d", 5), ...prev.map((r) => ({ ...r }))], byId);
      expect(more.slice(1)).toEqual(prev);
      expect(more[1]).toBe(prev[0]);
    });
  });
});
