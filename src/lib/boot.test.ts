// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  advance,
  BOOT_FAILSAFE_MS,
  BOOT_FIRST_BREATH_MS,
  BOOT_OPEN_MS,
  holdMs,
  shouldArm,
  SNAPBACK_SETTLE_MS,
} from "./boot";

describe("shouldArm", () => {
  it("arms only a fresh launch with motion allowed", () => {
    expect(shouldArm({ reducedMotion: false, alreadyPlayed: false })).toBe(
      true,
    );
    expect(shouldArm({ reducedMotion: true, alreadyPlayed: false })).toBe(
      false,
    );
    expect(shouldArm({ reducedMotion: false, alreadyPlayed: true })).toBe(
      false,
    );
    expect(shouldArm({ reducedMotion: true, alreadyPlayed: true })).toBe(false);
  });
});

describe("advance", () => {
  it("parts the doors on reveal", () => {
    expect(advance("closed", "reveal")).toBe("opening");
  });
  it("skip settles from any live phase — the user outranks the doors", () => {
    expect(advance("closed", "skip")).toBe("settled");
    expect(advance("opening", "skip")).toBe("settled");
  });
  it("timeout settles from any live phase", () => {
    expect(advance("closed", "timeout")).toBe("settled");
    expect(advance("opening", "timeout")).toBe("settled");
  });
  it("settled is absorbing", () => {
    expect(advance("settled", "reveal")).toBe("settled");
    expect(advance("settled", "skip")).toBe("settled");
    expect(advance("settled", "timeout")).toBe("settled");
  });
  it("a second reveal mid-opening changes nothing", () => {
    expect(advance("opening", "reveal")).toBe("opening");
  });
});

describe("timings", () => {
  it("first launches breathe, replays don't", () => {
    expect(holdMs(true)).toBe(BOOT_FIRST_BREATH_MS);
    expect(holdMs(false)).toBe(0);
  });
  it("the dead-man switch outlasts the longest legitimate run", () => {
    // Breath + opening + generous frame slack must land BEFORE the module
    // failsafe force-removes the attribute, or a healthy boot gets cut off.
    expect(BOOT_FIRST_BREATH_MS + BOOT_OPEN_MS + 300).toBeLessThanOrEqual(
      BOOT_FAILSAFE_MS,
    );
  });
  it("the snap-back fold is brisker than the boot", () => {
    expect(SNAPBACK_SETTLE_MS).toBeLessThan(BOOT_OPEN_MS);
  });
});

// Source invariants on styles.css — the CSS half of the choreography lives
// there and these two contracts cannot be expressed in TypeScript.
describe("boot CSS contract", () => {
  const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

  it("the doors only ever move under prefers-reduced-motion: no-preference", () => {
    // Every data-rl-boot selector must live inside the doors section, and
    // that section's rules must sit inside its motion-allowed media block —
    // reduced motion means the closed frame never exists, not a fast fade.
    const start = css.indexOf("Doors-open boot");
    const end = css.indexOf("Snap-back settle");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const doors = css.slice(start, end);
    const outside =
      css.slice(0, start).includes("[data-rl-boot") ||
      css.slice(end).includes("[data-rl-boot");
    expect(outside).toBe(false);
    const media = doors.indexOf(
      "@media (prefers-reduced-motion: no-preference)",
    );
    const firstBoot = doors.indexOf("[data-rl-boot");
    expect(media).toBeGreaterThan(-1);
    expect(firstBoot).toBeGreaterThan(media);
  });

  it("the opening stagger finishes inside the hard settle timeout", () => {
    // Longest transition-delay + longest transition duration in the boot
    // block must fit in BOOT_OPEN_MS, or the hard timeout truncates the
    // document plate's resolve. Scoped to the doors section by its markers —
    // the rest of the sheet has its own unrelated transitions.
    const start = css.indexOf("Doors-open boot");
    const end = css.indexOf("Snap-back settle");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const doors = css.slice(start, end);
    const delays = [...doors.matchAll(/transition-delay:\s*(\d+)ms/g)].map(
      (m) => Number(m[1]),
    );
    const durations = [
      ...doors.matchAll(/transition:[^;]*?(\d+)ms cubic-bezier/g),
    ].map((m) => Number(m[1]));
    expect(delays.length).toBeGreaterThan(0);
    expect(durations.length).toBeGreaterThan(0);
    expect(Math.max(...delays) + Math.max(...durations)).toBeLessThanOrEqual(
      BOOT_OPEN_MS,
    );
  });
});

// Source invariants on App.tsx — the boot-path JS contract (A0). The doors
// give ~700ms of cover; the deal that keeps boot JS under budget WITHOUT a
// blank frame behind the parting plates is: heavy surfaces load lazily, and
// the one surface boot will actually land on is prefetched the moment
// `initialSurface` resolves. These pins keep both halves of that deal from
// silently regressing.
describe("boot-path JS contract", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  // Everything here was once a static import that cost the boot budget its
  // headroom. `import type` is fine (erased at build); a VALUE import is the
  // regression.
  const LAZY_ONLY = [
    "PlanEditor",
    "PromptDrafter",
    "VoicePanel",
    "ShareSnapshotDialog",
    "MemorySurface",
    "OrchestrationSurface",
    "BrowserPane",
    "MemoryInspector",
    "BookshelfView",
    "AgentShelf",
    "OnboardingTour",
    "SessionSidebar",
    "FileViewer",
    // The chat room. Not optional: the boot path sits at ~97% of its ceiling,
    // so a room in the entry chunk would blow `size-budget.json` outright.
    "ChatRoom",
  ];

  it("the heavy surfaces never return to App's static import list", () => {
    for (const name of LAZY_ONLY) {
      const staticImport = new RegExp(
        `^import (?!type\\b)[^;]*from "\\./components/${name}"`,
        "m",
      );
      expect(app.match(staticImport), `${name} is statically imported`).toBe(
        null,
      );
      expect(
        app.includes(`import("./components/${name}")`),
        `${name} lost its lazy() import`,
      ).toBe(true);
    }
  });

  it("the terminal dock stays static — it is first paint", () => {
    expect(app).toMatch(
      /^import { TerminalTabs } from "\.\/components\/TerminalTabs";/m,
    );
  });

  it("harness edits land on refocus — the A5a dev loop", () => {
    // A link-installed harness is read through its link, so a re-list is a
    // re-read: the focus listener IS the edit loop ("edit harness.json,
    // refocus Redline, the change is live"), and the DOM event is the
    // Extensions panel announcing an install that happened with the window
    // already focused. Both funnel through the same resolution the boot
    // pass uses, so a deleted harness exits cleanly everywhere.
    expect(app).toContain('window.addEventListener("focus", refreshHarnesses)');
    expect(app).toContain(
      'window.addEventListener("redline:harnesses-changed", refreshHarnesses)',
    );
    expect(app).toContain("const resolved = applyHarnessResolution(installed)");
  });

  it("boot prefetches the landing surface's chunk under the doors", () => {
    // The map must cover every lazily-loaded surface body, and the boot
    // effect must warm the resolved landing target plus the sidebar's
    // resting tab. A lazy surface missing from the map is a surface that CAN
    // blank behind the doors when a manifest lands boot on it.
    const map = app.match(
      /const SURFACE_CHUNK_LOADERS[\s\S]*?= \{([\s\S]*?)\}/,
    );
    expect(map, "SURFACE_CHUNK_LOADERS map missing").not.toBe(null);
    for (const key of ["document", "drafter", "browser", "memory", "runs", "chat"]) {
      expect(map![1].includes(`${key}:`), `${key} missing from loader map`).toBe(
        true,
      );
    }
    expect(app).toContain("prefetchSurfaceChunk(target)");
    expect(app).toContain("void loadSessionSidebar().catch(() => {})");
  });

  it("the first frame composes from the paint caches, not the defaults", () => {
    // The manifest (and any active harness) is read over IPC AFTER first
    // paint — so without the synchronous localStorage mirrors, a manifest
    // that hides surfaces (or a harness that rebrands them) flashes the
    // stock header on every launch. The state INITIALIZERS must read the
    // caches; the boot effect then confirms against the file and refreshes
    // them (storeWorkspaceCache / storeActiveHarness).
    expect(app).toContain(
      "readWorkspaceCache(localStorage) ?? defaultWorkspace()",
    );
    expect(app).toContain("readActiveHarness(localStorage)");
    expect(app).toContain("storeWorkspaceCache(localStorage,");
    expect(app).toContain("storeActiveHarness(localStorage, resolved)");
  });

  it("the surface dispatch is a lenient record, not a closed ternary", () => {
    // Manifests (workspace.json, a harness pack) name surfaces as strings;
    // dispatch over a Record lets an id this build can't render degrade to
    // no body instead of failing a closed union (A5).
    expect(app).toContain(
      "const surfaceBodies: Record<string, ReactNode | undefined>",
    );
    expect(app).toContain("surfaceBodies[mainSurface]");
  });

  it("plate fallbacks stay quiet — null, never a spinner", () => {
    // The bodies that sit inside an animating plate suspend to NOTHING; a
    // fallback flashing inside the parting doors reads as a glitch. Count
    // enforced ≥ the sites wrapped by A0 so a new quiet site never fails
    // this, while flipping an existing null to a visible fallback does.
    const quiet = app.match(/<Suspense fallback=\{null\}>/g) ?? [];
    expect(quiet.length).toBeGreaterThanOrEqual(8);
  });
});
