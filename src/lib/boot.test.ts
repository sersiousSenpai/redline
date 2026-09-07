// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  advance,
  BOOT_FAILSAFE_MS,
  BOOT_OPEN_MS,
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
  it("the dead-man switch outlasts the longest legitimate run", () => {
    // Opening + generous frame slack must land BEFORE the module failsafe
    // force-removes the attribute, or a healthy boot gets cut off.
    expect(BOOT_OPEN_MS + 300).toBeLessThanOrEqual(BOOT_FAILSAFE_MS);
  });

  it("the whole decorative run fits the brisk band", () => {
    // The run used to be 750ms because the shell WAITED for it. Now that
    // nothing actionable does, it is a plate resolve: long enough to read as
    // motion, over before a hand reaches the keyboard. The upper bound is the
    // ratchet — raising it is a deliberate, reviewed diff of this number.
    expect(BOOT_OPEN_MS).toBeGreaterThanOrEqual(200);
    expect(BOOT_OPEN_MS).toBeLessThanOrEqual(320);
  });

  it("the boot and the snap-back fold are the same brisk band", () => {
    // Both are short decorative folds now; neither may become a wait.
    expect(SNAPBACK_SETTLE_MS).toBeLessThanOrEqual(BOOT_OPEN_MS + 40);
    expect(BOOT_OPEN_MS).toBeLessThanOrEqual(SNAPBACK_SETTLE_MS + 40);
  });
});

// The A2 animation is DECORATIVE. These are the source invariants that keep it
// that way — the regression they exist to catch is the one that shipped: a
// 750ms plate choreography that the front door gated its autofocus on, so
// every launch carried a fixed interaction floor nobody had chosen.
describe("the animation never gates actionability", () => {
  const hook = readFileSync(
    join(process.cwd(), "src/hooks/useBootChoreography.ts"),
    "utf8",
  );
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
  const door = readFileSync(
    join(process.cwd(), "src/components/FrontDoor.tsx"),
    "utf8",
  );

  it("the hook reports only whether the plates are mid-flight", () => {
    // The interface carries one field and the hook returns one field. There
    // is no settled/ready boolean to gate on, which is the guard: the old
    // `bootSettled` could not be misused if it does not exist.
    const iface = hook.match(
      /export interface BootChoreography \{([\s\S]*?)\n\}/,
    );
    expect(iface, "BootChoreography interface missing").not.toBe(null);
    const fields = [...iface![1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(fields).toEqual(["bootAnimating"]);
    expect(hook).toContain("return { bootAnimating: !settled };");
  });

  it("App reads the phase only where plate geometry is the question", () => {
    // Four consumers, each because something paints over or measures against
    // a plate that is still travelling:
    //   1. `browserVisible`  — the native child webview ignores DOM transforms
    //   2. `tourActive`      — a coachmark pinned to a moving plate misses
    //   3. the tour's render — same, at the mount site
    //   4. the document plate's "Loading…" — a flash inside parting doors
    // Plus the destructuring in App's body. A fifth consumer needs its own
    // geometry reason; an actionability reason is exactly what is banned.
    const uses = [...app.matchAll(/bootAnimating/g)].length;
    expect(uses, "a new bootAnimating consumer needs a geometry reason").toBe(
      5,
    );
    expect(app).not.toContain("bootSettled");
  });

  it("the front door's visibility never conjoins a boot phase", () => {
    const visible = app.match(/<FrontDoor\s+visible=\{([^}]*)\}/);
    expect(visible, "FrontDoor lost its visible prop").not.toBe(null);
    expect(visible![1]).not.toMatch(/boot/i);
    expect(door).toContain("Deliberately NOT the boot choreography");
  });

  it("there is no first-run hold left to reinstate", () => {
    const boot = readFileSync(join(process.cwd(), "src/lib/boot.ts"), "utf8");
    expect(boot).not.toContain("BOOT_FIRST_BREATH_MS");
    expect(boot).not.toContain("export function holdMs");
    expect(hook).not.toContain("holdMs");
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

// Source invariants on App.tsx — the boot-path JS contract (A0). The deal that
// keeps boot JS under budget WITHOUT a blank frame behind the parting plates
// is: heavy surfaces load lazily, and the one surface boot will actually land
// on is prefetched the moment `initialSurface` resolves. These pins keep both
// halves of that deal from silently regressing.
//
// The prefetch half matters MORE now, not less. It used to have ~700ms of door
// animation to hide behind; the doors are 300ms and no longer gate anything,
// so a lazy surface missing from the loader map shows its own emptiness.
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

  // The raw-wire inspector is devtools: most turns never open it, and it is
  // reached from a chip on the turn badge rather than from App. So the guard
  // is not "App doesn't import it" — it is "NOTHING imports it statically",
  // which is the property that actually keeps it out of every chunk but its
  // own.
  it("the stream inspector is only ever reached through import()", () => {
    const dir = join(process.cwd(), "src/components");
    const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
    // Non-vacuous: an empty list would pass the loop below silently.
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      if (file === "StreamInspector.tsx") continue;
      const src = readFileSync(join(dir, file), "utf8");
      expect(
        src.match(/^import (?!type\b)[^;]*from "\.\/StreamInspector"/m),
        `${file} statically imports StreamInspector`,
      ).toBe(null);
    }
    const bubble = readFileSync(join(dir, "StreamingBubble.tsx"), "utf8");
    expect(bubble).toContain('import("./StreamInspector")');
  });

  it("the terminal dock is deferred, and its mount is queued not raced", () => {
    // This used to assert the OPPOSITE — that TerminalTabs was a static import
    // because "it is first paint". It isn't: mounting it loads xterm, spawns a
    // PTY and starts the cwd poll, all while the front door is still coming
    // up, for a dock most launches don't touch until after they have typed a
    // sentence. The dock's SHELL (plate, divider, geometry) is still first
    // paint; the tabs arrive on the first of an idle callback, the user
    // opening the dock, or a launch that needs one.
    expect(app).not.toMatch(
      /^import { TerminalTabs } from "\.\/components\/TerminalTabs";/m,
    );
    expect(app).toContain('import("./components/TerminalTabs")');
    // The whole reason deferral is safe: launch intent WAITS for the dock
    // instead of finding no handle and reporting "couldn't open a terminal".
    expect(app).toContain("const ensureTerminalReady = useCallback(");
    const openers = [...app.matchAll(/openSessionTerminal\(/g)].length;
    const awaited = [
      ...app.matchAll(/ensureTerminalReady\(\)\)?[\s\S]{0,60}?openSessionTerminal/g),
    ].length;
    expect(
      awaited,
      `${openers - awaited} openSessionTerminal call(s) bypass ensureTerminalReady`,
    ).toBe(openers);
  });

  it("the dock is never unmounted by surface navigation", () => {
    // The PTYs and their scrollback die with it. `terminalMounted` is
    // one-way — nothing may set it false.
    expect(app).toContain("setTerminalMounted(true)");
    expect(app).not.toContain("setTerminalMounted(false)");
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
    // The boot pass and the refocus pass must go through the SAME resolver —
    // that shared call is what makes "edit harness.json, refocus, it's live"
    // work without two divergent read paths. Two call sites, one function:
    // the refocus `list_harnesses` and boot's `bootstrap_state` payload.
    expect(app).toContain(".then(applyHarnessResolution)");
    expect(app).toContain("applyHarnessResolution(boot?.harnesses ?? [])");
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
