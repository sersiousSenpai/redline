// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { fuzzyScore, indexFiles, rankFiles, type ListedEntry } from "./quickOpen";

const tree: Record<string, ListedEntry[]> = {
  "/r": [
    { name: "src", path: "/r/src", isDir: true },
    { name: "node_modules", path: "/r/node_modules", isDir: true },
    { name: "README.md", path: "/r/README.md", isDir: false },
  ],
  "/r/src": [
    { name: "App.tsx", path: "/r/src/App.tsx", isDir: false },
    { name: "lib", path: "/r/src/lib", isDir: true },
  ],
  "/r/src/lib": [{ name: "quickOpen.ts", path: "/r/src/lib/quickOpen.ts", isDir: false }],
  "/r/node_modules": [{ name: "huge.js", path: "/r/node_modules/huge.js", isDir: false }],
};
const lister = (p: string) => (tree[p] ? Promise.resolve(tree[p]) : Promise.reject(new Error("nope")));

describe("indexFiles", () => {
  it("walks breadth first, relative to the root, skipping dependency folders", async () => {
    const { files, truncated } = await indexFiles("/r/", lister);
    expect(files).toEqual(["README.md", "src/App.tsx", "src/lib/quickOpen.ts"]);
    expect(truncated).toBe(false);
  });
  it("stops at the cap and says so", async () => {
    const { files, truncated } = await indexFiles("/r", lister, { cap: 2 });
    expect(files.length).toBe(2);
    expect(truncated).toBe(true);
  });
  it("skips a folder it cannot list", async () => {
    const { files } = await indexFiles("/missing", lister);
    expect(files).toEqual([]);
  });
});

describe("fuzzy rank", () => {
  const files = ["src/App.tsx", "src/lib/quickOpen.ts", "src/components/plan/FeedbackPanel.tsx", "docs/app-notes.md"];
  it("needs the letters in order", () => {
    expect(fuzzyScore("qo", "src/lib/quickOpen.ts")).not.toBeNull();
    expect(fuzzyScore("oq", "src/lib/quickOpen.ts")).toBeNull();
  });
  it("prefers a match in the file name", () => {
    expect(rankFiles("app", files)[0]).toBe("src/App.tsx");
    expect(rankFiles("fbp", files)[0]).toBe("src/components/plan/FeedbackPanel.tsx");
  });
  it("lists the shallowest files for an empty query", () => {
    expect(rankFiles("", files, 2)).toEqual(["docs/app-notes.md", "src/App.tsx"]);
  });
});
