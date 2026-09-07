// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it } from "vitest";
import {
  AWAY_SEEN_KEY,
  awayCardLine,
  markAwaySeen,
  summarizeAway,
  takeAwayWatermark,
  visibleAway,
  type AwayCard,
} from "./awayFeed";

const card = (kind: string, over: Partial<AwayCard> = {}): AwayCard => ({
  kind,
  itemId: "rl-1",
  title: "Ship it",
  detail: null,
  at: 1000,
  ...over,
});

describe("takeAwayWatermark", () => {
  beforeEach(() => localStorage.clear());

  it("seeds on first use and asks for nothing", () => {
    // A fresh install greeted with its entire history is not news, it is an
    // archive — so the first read establishes the mark and returns null.
    expect(takeAwayWatermark(localStorage, 5000)).toBeNull();
    expect(localStorage.getItem(AWAY_SEEN_KEY)).toBe("5000");
  });

  it("returns the mark on every read after that, without moving it", () => {
    takeAwayWatermark(localStorage, 5000);
    expect(takeAwayWatermark(localStorage, 9000)).toBe(5000);
    expect(takeAwayWatermark(localStorage, 9000)).toBe(5000);
    expect(localStorage.getItem(AWAY_SEEN_KEY)).toBe("5000");
  });

  it("re-seeds past a corrupt or nonsensical value", () => {
    for (const bad of ['"not a number"', "0", "-1", "null", "{oops"]) {
      localStorage.setItem(AWAY_SEEN_KEY, bad);
      expect(takeAwayWatermark(localStorage, 7000)).toBeNull();
      expect(localStorage.getItem(AWAY_SEEN_KEY)).toBe("7000");
    }
  });

  it("markAwaySeen moves the mark forward", () => {
    takeAwayWatermark(localStorage, 5000);
    markAwaySeen(localStorage, 8000);
    expect(takeAwayWatermark(localStorage, 9000)).toBe(8000);
  });
});

describe("summarizeAway", () => {
  it("says nothing about nothing", () => {
    const s = summarizeAway([]);
    expect(s.total).toBe(0);
    expect(s.headline).toBe("");
  });

  it("leads with what finished, then arrivals, then moot turns", () => {
    const s = summarizeAway([
      card("arrived"),
      card("moot"),
      card("closed"),
      card("closed"),
    ]);
    expect(s.headline).toBe("2 items closed · 1 new item arrived · 1 moot turn");
    expect(s).toMatchObject({ total: 4, closed: 2, arrived: 1, moot: 1 });
  });

  it("gets its plurals right", () => {
    expect(summarizeAway([card("closed")]).headline).toBe("1 item closed");
    expect(summarizeAway([card("moot"), card("moot")]).headline).toBe(
      "2 moot turns",
    );
  });

  it("counts a kind this build doesn't know rather than hiding it", () => {
    // An older frontend against a newer backend must never claim less
    // happened than the list below it shows.
    const s = summarizeAway([card("closed"), card("some-future-kind")]);
    expect(s.total).toBe(2);
    expect(s.headline).toBe("1 item closed · 1 update");
  });
});

describe("visibleAway", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => card("closed", { itemId: `rl-${i}` }));

  it("shows everything when it fits", () => {
    expect(visibleAway(many(3))).toEqual({ shown: many(3), more: 0 });
  });

  it("counts the overflow instead of listing it", () => {
    const r = visibleAway(many(9));
    expect(r.shown).toHaveLength(5);
    expect(r.more).toBe(4);
  });

  it("the boundary is not an overflow", () => {
    expect(visibleAway(many(5)).more).toBe(0);
  });
});

describe("awayCardLine", () => {
  it("names the event and its one detail", () => {
    expect(awayCardLine(card("closed", { detail: "shipped" }))).toBe(
      "Closed — shipped",
    );
    expect(awayCardLine(card("moot", { detail: "skeptic" }))).toBe(
      "Moot — skeptic",
    );
  });

  it("stands alone when there is no detail", () => {
    expect(awayCardLine(card("arrived"))).toBe("Arrived");
    expect(awayCardLine(card("arrived", { detail: "  " }))).toBe("Arrived");
  });

  it("shows an unknown kind verbatim rather than mislabelling it", () => {
    expect(awayCardLine(card("some-future-kind"))).toBe("some-future-kind");
  });
});
