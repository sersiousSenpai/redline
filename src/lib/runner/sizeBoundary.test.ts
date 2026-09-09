// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

describe("run canvas loading boundary", () => {
  it("keeps the canvas library in the already lazy Runs surface", () => {
    const offenders: string[] = [];
    const root = join(process.cwd(), "src");
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!/\.(tsx?|css)$/.test(path) || path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
        if (/from\s+["']@xyflow\/|import\s+["']@xyflow\//.test(readFileSync(path, "utf8")) && !relative(root, path).startsWith("components/runner/")) offenders.push(relative(root, path));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
    const app = readFileSync(join(root, "App.tsx"), "utf8");
    expect(/const loadOrchestrationSurface = \(\) => import\("\.\/components\/OrchestrationSurface"\)/.test(app)).toBe(true);
    expect(/const OrchestrationSurface = lazy\(\(\) =>\s*loadOrchestrationSurface\(\)/.test(app)).toBe(true);
  });
});
