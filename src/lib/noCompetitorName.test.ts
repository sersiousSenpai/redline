// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Another plan-review tool is a source of interaction patterns only; its name
// never appears in this repo. Code says what that tool's hook does ("another
// plan-review hook", "a conflicting PreToolUse hook"), docs say "the
// reference product", and the hook-conflict detector recognizes the hook by
// digest (`src-tauri/src/hook_conflicts.rs`). This test reads every tracked
// and not-ignored file and fails on the name in any case. The name is spelled
// here as bytes, so this file passes its own check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const NAME = String.fromCharCode(0x70, 0x6c, 0x61, 0x6e, 0x6e, 0x6f, 0x74, 0x61, 0x74, 0x6f, 0x72);

describe("the reference product's name", () => {
  it("appears in no tracked or new file, in any case", () => {
    const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = [...new Set(listed.split("\0").filter(Boolean))];
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((path) => {
      if (!existsSync(path) || !statSync(path).isFile()) return false;
      return readFileSync(path).toString("latin1").toLowerCase().includes(NAME);
    });
    expect(hits).toEqual([]);
  });
});
