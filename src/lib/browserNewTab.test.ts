// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  agentSearchTurn, CLOSED_PAGES_CAP, dateSpan, denylistCount, newTabKicker, pickBackUp, readingBySubject,
  rememberClosed, searchAddress, shortAge,
} from "./browserNewTab";
import { SEARCH_URL } from "./omnibox";

// Tuesday 2026-10-27, 1:52 AM local.
const NOW = new Date(2026, 9, 27, 1, 52).getTime();
const MIN = 60_000, DAY = 86_400_000;

describe("newTabKicker", () => {
  it("says the day, the time and how many pages are open, and needs-you only when something does", () => {
    expect(newTabKicker(new Date(NOW), 5)).toBe("Tuesday · 1:52 AM · 5 pages open");
    expect(newTabKicker(new Date(NOW), 1)).toBe("Tuesday · 1:52 AM · 1 page open");
    expect(newTabKicker(new Date(NOW), 0)).toBe("Tuesday · 1:52 AM");
    expect(newTabKicker(new Date(NOW), 5, 2)).toBe("Tuesday · 1:52 AM · 5 pages open · 2 need you");
    expect(newTabKicker(new Date(2026, 9, 27, 13, 5), 2)).toBe("Tuesday · 1:05 PM · 2 pages open");
  });
});

describe("shortAge and dateSpan", () => {
  it("reads minutes, hours, yesterday, then a date", () => {
    expect(shortAge(undefined, NOW)).toBe("");
    expect(shortAge(NOW - 20 * MIN, NOW)).toBe("20m");
    expect(shortAge(NOW - 3 * 60 * MIN, NOW)).toBe("3h");
    expect(shortAge(NOW - DAY, NOW)).toBe("yesterday");
    expect(shortAge(new Date(2026, 9, 22, 9).getTime(), NOW)).toBe("Oct 22");
  });
  it("spans a subject's pages", () => {
    expect(dateSpan([new Date(2026, 9, 9).getTime(), new Date(2026, 9, 18).getTime()], NOW)).toBe("Oct 9–18");
    expect(dateSpan([new Date(2026, 8, 30).getTime(), new Date(2026, 9, 2).getTime()], NOW)).toBe("Sep 30 – Oct 2");
    expect(dateSpan([NOW - 2 * DAY, NOW - DAY], NOW)).toBe("this week");
    expect(dateSpan([NOW - MIN], NOW)).toBe("today");
    expect(dateSpan([], NOW)).toBe("");
  });
});

describe("pickBackUp", () => {
  const tabs = [
    { id: "new", browseId: "b0", title: "New tab", url: "redline:newtab" },
    { id: "a", browseId: "b1", title: "Plan · Durable jobs", url: "http://localhost:5173/plan" },
    { id: "b", browseId: "b2", title: "", url: "https://github.com/x/y/pull/412" },
  ];
  it("lists this workspace's other pages, freshest first, then unfinished task lists", () => {
    const rows = pickBackUp({
      tabs, currentId: "new",
      recent: [{ url: "https://github.com/x/y/pull/412", title: "PR", at: NOW - 5 * MIN }, { url: "http://localhost:5173/plan", title: "Plan", at: NOW - 60 * MIN }],
      tasks: [{ url: "https://docs.test/a", title: "Docs", count: 3 }, { url: "http://localhost:5173/plan", title: "Plan", count: 1 }],
    });
    expect(rows.map((r) => [r.kind, r.title, r.detail])).toEqual([
      ["tab", "github.com", "github.com"],
      ["tab", "Plan · Durable jobs", "localhost"],
      ["tasks", "Docs", "3 unfinished tasks"],
    ]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, browseId: `b${i}`, title: `P${i}`, url: `https://p${i}.test` }));
    expect(pickBackUp({ tabs: many, currentId: "t0", recent: [], tasks: [] })).toHaveLength(6);
  });
});

describe("readingBySubject", () => {
  it("groups pages not open now by their mission, else their site, biggest subject first", () => {
    const at = (d: number) => new Date(2026, 9, d).getTime();
    const groups = readingBySubject({
      recent: [
        { url: "https://arxiv.org/abs/1", title: "LiDAR-GS", at: at(9) },
        { url: "https://github.com/kiss-icp", title: "KISS-ICP", at: at(22) },
        { url: "https://en.wikipedia.org/wiki/ICP", title: "Iterative closest point", at: at(20) },
        { url: "https://www.tauri.app/docs", title: "Tauri docs", at: at(26) },
        { url: "https://open.test/now", title: "Open now", at: at(26) },
      ],
      candidates: [
        { browseId: "1", url: "https://arxiv.org/abs/1", mission: "LiDAR GS research" },
        { browseId: "2", url: "https://github.com/kiss-icp", mission: "LiDAR GS research" },
        { browseId: "3", url: "https://en.wikipedia.org/wiki/ICP", mission: "LiDAR GS research" },
      ],
      openUrls: new Set(["https://open.test/now"]),
      now: NOW,
    });
    expect(groups.map((g) => [g.kind, g.name, g.pages.length, g.span])).toEqual([
      ["mission", "LiDAR GS research", 3, "Oct 9–22"],
      ["site", "tauri.app", 1, "this week"],
    ]);
    expect(groups[0].pages.map((p) => p.title)).toEqual(["KISS-ICP", "Iterative closest point", "LiDAR-GS"]);
  });
});

describe("the omnibox's verbs and the closed list", () => {
  it("searches the query and words the agent's turn", () => {
    expect(searchAddress(" token bucket ")).toBe(`${SEARCH_URL}token%20bucket`);
    expect(agentSearchTurn(" token bucket ")).toMatch(/^Find the best page for: token bucket\n\nOpen the most useful result as a tab, answer here/);
  });
  it("remembers closed web pages newest first, once each, up to the cap", () => {
    let list = rememberClosed([], { url: "redline:newtab", title: "New tab", at: 1 });
    expect(list).toEqual([]);
    for (let i = 0; i < CLOSED_PAGES_CAP + 2; i++) list = rememberClosed(list, { url: `https://p${i}.test`, title: `P${i}`, at: i });
    list = rememberClosed(list, { url: "https://p11.test", title: "P11 again", at: 99 });
    expect(list).toHaveLength(CLOSED_PAGES_CAP);
    expect(list[0]).toEqual({ url: "https://p11.test", title: "P11 again", at: 99 });
    expect(list.filter((p) => p.url === "https://p11.test")).toHaveLength(1);
  });
  it("counts never-capture domains, skipping comments and blanks", () => {
    expect(denylistCount("# one per line\nmail.google.com\n\n bank.test \n")).toBe(2);
    expect(denylistCount(null)).toBe(0);
  });
});
