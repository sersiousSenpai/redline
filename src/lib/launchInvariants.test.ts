// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Cross-file laws. The house pattern for a claim that spans files and has no
// pure home — each one here is a rule that a future edit could break silently
// and that no unit test would notice.

const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8");
const app = read("src/App.tsx");
const drafter = read("src/components/PromptDrafter.tsx");

describe("one launch pipeline", () => {
  it("the plan launch command is built in exactly one place", () => {
    // Three surfaces launch the same `claude --permission-mode plan`. A second
    // construction site is how they drifted apart in the first place — only one
    // of them gated on readiness or handled a missing terminal.
    const hits = countIn("src", "buildPlanLaunchCommand(");
    expect(hits, `built in ${hits} places`).toBe(1);
  });

  it("the ledger write is followed by a .catch — the missing one, as a guard", () => {
    const at = app.indexOf("record_plan_launch");
    expect(at).toBeGreaterThan(-1);
    const after = app.slice(at, at + 700);
    expect(
      after,
      "a bare `void invoke(...)` here made a failed ledger write 100% silent",
    ).toContain(".catch(");
  });

  it("the pending launch is NEVER persisted", () => {
    // A stale "Planning…" card outliving a restart claims a session that
    // certainly isn't running.
    expect(app).toContain("useState<PendingLaunch | null>(null)");
    expect(app).not.toContain('usePersistedState<PendingLaunch');
  });
});

describe("the second door adds no new probing", () => {
  it("preflight_status is INVOKED in exactly one place", () => {
    // It re-runs `resolve_claude_bin`'s `$SHELL -ilc` fallback, which spawns a
    // TCC-visible child process — which is why App dedupes it behind a ref.
    // A second caller would double that cost for nothing. Counted as a CALL,
    // not as a word: the name appears in doc comments too, and pinning those
    // would make this fail on a rewording.
    expect(countIn("src", 'invoke<PreflightStatus>("preflight_status")')).toBe(1);
  });

  it("PromptDrafter probes nothing itself — it renders what App derived", () => {
    expect(drafter).not.toContain('invoke("preflight_status"');
    expect(drafter).not.toContain('invoke<PreflightStatus>');
    expect(drafter).not.toContain("deriveReadiness(");
  });
});

describe("readiness in the Drafter is deliberately asymmetric", () => {
  it("renders BlockedLaunch but never a standing strip", () => {
    // Decision 4: readiness appears at exactly two moments — a refused launch,
    // and a pending one that has gone quiet. A permanent fault row under
    // someone's prose is chrome they learn to stop seeing, which is the exact
    // failure readiness exists to fix.
    expect(drafter).toContain("BlockedLaunch");
    expect(drafter).not.toContain("<ReadinessStrip items={readiness}");
  });

  it("but the blocker itself is never optional", () => {
    // Without it the Drafter runs the identical launch with zero preflight and
    // hands the user a terminal spinning over nothing.
    expect(drafter).toContain("attemptLaunch(readiness)");
  });
});

describe("the project pick is tagged", () => {
  it("the load effect no longer guards with `if (path)`", () => {
    // That guard is what let document A's repo answer for document B —
    // permanently reassigning B and launching its prompt into the wrong cwd.
    expect(app).not.toMatch(/if \(loaded\?\.projectPath\) setDrafterProject/);
    expect(app).toContain("setDrafterProject({ forId");
  });

  it("the persist unwraps through projectForDoc", () => {
    const persist = app.indexOf("const drafterPersist");
    const end = app.indexOf("[drafterDraftId, drafterProject]", persist);
    expect(app.slice(persist, end)).toContain("projectForDoc(drafterProject");
  });
});

/** Count occurrences of `needle` across the .ts/.tsx files under `dir`,
 *  excluding tests (which quote these names to pin them). */
function countIn(dir: string, needle: string): number {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  let n = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(join(process.cwd(), d))) {
      const rel = `${d}/${entry}`;
      const full = join(process.cwd(), rel);
      if (statSync(full).isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const text = readFileSync(full, "utf8");
      let i = text.indexOf(needle);
      while (i !== -1) {
        // Skip the import statement — importing a symbol isn't a call site.
        const lineStart = text.lastIndexOf("\n", i) + 1;
        const line = text.slice(lineStart, text.indexOf("\n", i));
        if (!/^\s*(import|export)\b/.test(line) && !line.trimStart().startsWith("*"))
          n += 1;
        i = text.indexOf(needle, i + 1);
      }
    }
  };
  walk(dir);
  return n;
}
