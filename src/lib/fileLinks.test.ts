// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";

import { OPEN_FILE_EVENT, findFileLinks, openFileLink, resolveFileLink } from "./fileLinks";

const paths = (line: string) => findFileLinks(line).map((m) => [m.path, m.line ?? null, m.col ?? null]);

describe("findFileLinks", () => {
  it("finds paths with a line and a column, where a compiler or a test runner prints them", () => {
    expect(paths("src/App.tsx:120:7 - error TS2304")).toEqual([["src/App.tsx", 120, 7]]);
    expect(paths("  at render (/Users/me/r/src/main.tsx:42)")).toEqual([["/Users/me/r/src/main.tsx", 42, null]]);
    expect(paths("FAIL  src/lib/keymap.test.ts > the registry")).toEqual([["src/lib/keymap.test.ts", null, null]]);
    expect(paths("edited README.md and ./scripts/redline.sh.")).toEqual([["README.md", null, null], ["./scripts/redline.sh", null, null]]);
    expect(paths("see ~/notes/plan.md:3")).toEqual([["~/notes/plan.md", 3, null]]);
  });
  it("leaves URLs, versions, numbers and words alone", () => {
    expect(paths("open https://example.com/a/b.html now")).toEqual([]);
    expect(paths("node v20.11.1 and 3.14 and done.")).toEqual([]);
    expect(paths("user@example.com")).toEqual([]);
    expect(paths("/ and .. and ...")).toEqual([]);
  });
  it("reports where each sits in the line", () => {
    const [m] = findFileLinks("x src/a.ts:9 y");
    expect([m.start, m.end, m.text]).toEqual([2, 12, "src/a.ts:9"]);
  });
});

describe("resolveFileLink", () => {
  it("resolves against the cwd and home, folding dots", () => {
    expect(resolveFileLink("src/a.ts", "/r/")).toBe("/r/src/a.ts");
    expect(resolveFileLink("../b/c.ts", "/r/x")).toBe("/r/b/c.ts");
    expect(resolveFileLink("./c.ts", "/r")).toBe("/r/c.ts");
    expect(resolveFileLink("/abs/d.ts", null)).toBe("/abs/d.ts");
    expect(resolveFileLink("~/n.md", null, "/Users/me")).toBe("/Users/me/n.md");
    expect(resolveFileLink("rel.ts", null)).toBeNull();
  });
});

describe("openFileLink", () => {
  it("opens a file that exists, through the one window event, and never one that does not", async () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_FILE_EVENT, on);
    const exists = vi.fn(async (p: string) => p === "/r/src/a.ts");
    expect(await openFileLink({ path: "src/a.ts", line: 4 }, { cwd: "/r", home: null }, exists)).toBe(true);
    expect(await openFileLink({ path: "src/nope.ts" }, { cwd: "/r", home: null }, exists)).toBe(false);
    window.removeEventListener(OPEN_FILE_EVENT, on);
    expect(seen).toEqual([{ path: "/r/src/a.ts", line: 4, mode: "preview" }]);
  });
});

describe("App's listener", () => {
  it("spells the event the same way", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/App.tsx", "utf8")).toContain(`window.addEventListener("${OPEN_FILE_EVENT}", onOpen)`);
  });
});
