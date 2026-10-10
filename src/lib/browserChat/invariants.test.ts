// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INVARIANTS } from "./invariants";

// The catalogue is only worth something if every rule is pinned. A rule with
// no test naming its id fails here, and so does a test or comment citing an
// id the catalogue doesn't have.

const dir = join(process.cwd(), "src/lib/browserChat");
const files = readdirSync(dir).filter((f) => /\.(ts|tsx|md)$/.test(f)).map((f) => join(dir, f));
/** The code the layer governs, which may cite a rule beside the line that keeps it. */
const governed = [
  "src/components/BrowserChat.tsx",
  "src/components/BrowserPane.tsx",
  "src/App.tsx",
  "src-tauri/src/browse.rs",
  "src-tauri/src/browser_actions.rs",
  "src-tauri/src/claude_proc.rs",
  "src-tauri/src/lib.rs",
].map((rel) => join(process.cwd(), rel));
const tests = files.filter((f) => /\.test\.tsx?$/.test(f)).map((f) => readFileSync(f, "utf8"));
const titles = tests.flatMap((src) => [...src.matchAll(/\bit(?:\.fails|\.each\([^)]*\))?\(\s*"([^"]+)"/g)].map((m) => m[1]));
const ids = new Set(INVARIANTS.map((i) => i.id));

describe("the invariant catalogue", () => {
  it("has unique ids", () => {
    expect(ids.size).toBe(INVARIANTS.length);
  });
  it.each(INVARIANTS.map((i) => [i.id, i.rule] as const))("%s is pinned by at least one test", (id) => {
    expect(titles.some((t) => new RegExp(`(^|\\s)${id}(\\s|$)`).test(t)), `no test title names ${id}`).toBe(true);
  });
  it("every id cited in the layer or the code it governs exists", () => {
    const cited = [...files, ...governed].flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bBC-(R?\d+)\b/g)].map((m) => `BC-${m[1]}`));
    expect([...new Set(cited)].filter((id) => !ids.has(id))).toEqual([]);
  });
  it("every rule says where it was decided", () => {
    expect(INVARIANTS.filter((i) => !i.source.trim())).toEqual([]);
  });
});
