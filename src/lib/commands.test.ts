// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCommands,
  fuzzyScore,
  rankCommands,
  type CommandDeps,
  type PaletteCommand,
} from "./commands";

describe("fuzzyScore", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "Document")).toBeNull();
    expect(fuzzyScore("docs", "doc")).toBeNull();
  });
  it("matches the empty query at 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });
  it("is case-insensitive", () => {
    expect(fuzzyScore("THEME", "Theme: Studio")).toEqual(
      fuzzyScore("theme", "theme: studio"),
    );
  });
  it("treats query spaces as separators, not characters", () => {
    expect(fuzzyScore("theme stu", "Theme: Studio")).not.toBeNull();
  });
  it("scores a prefix above a scattered match", () => {
    const prefix = fuzzyScore("doc", "Document")!;
    const scattered = fuzzyScore("doc", "Reload once")!;
    expect(prefix).toBeGreaterThan(scattered);
  });
  it("rewards word starts", () => {
    const wordStart = fuzzyScore("stu", "Theme: Studio")!;
    const midWord = fuzzyScore("stu", "Restums")!;
    expect(wordStart).toBeGreaterThan(midWord);
  });
});

function cmd(id: string, title: string, detail?: string): PaletteCommand {
  return { id, title, group: "G", detail, run: () => {} };
}

describe("rankCommands", () => {
  const commands = [
    cmd("a", "Go to Document"),
    cmd("b", "Theme: Studio"),
    cmd("c", "Open plan: The studio memo", "redline"),
    cmd("d", "Reset the zoom"),
  ];
  it("browses in registry order on the empty query", () => {
    expect(rankCommands(commands, "").map((c) => c.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
  it("filters non-matches and ranks the strong match first", () => {
    const ids = rankCommands(commands, "theme").map((c) => c.id);
    expect(ids[0]).toBe("b");
    expect(ids).not.toContain("a");
  });
  it("searches the detail line too", () => {
    expect(rankCommands(commands, "redline").map((c) => c.id)).toContain("c");
  });
  it("keeps registry order on ties", () => {
    const tied = [cmd("x", "Same title"), cmd("y", "Same title")];
    expect(rankCommands(tied, "same").map((c) => c.id)).toEqual(["x", "y"]);
  });
});

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    surfaces: [
      { id: "document", label: "Document", title: "The plan document" },
      { id: "drafter", label: "Drafter", title: "Prompt drafter" },
    ],
    currentSurface: "document",
    sessions: [{ id: "s1", title: "Ship the palette", project: "redline" }],
    themes: [
      { name: "studio", label: "Studio" },
      { name: "terminal", label: "Terminal" },
    ],
    currentTheme: "terminal",
    fonts: [{ name: "san-francisco", label: "San Francisco" }],
    currentFont: "san-francisco",
    actions: {
      draftNewPlan: vi.fn(),
      openSession: vi.fn(),
      selectSurface: vi.fn(),
      snapBack: vi.fn(),
      toggleSidebar: vi.fn(),
      toggleDiscussion: vi.fn(),
      toggleTerminal: vi.fn(),
      toggleImmersive: vi.fn(),
      setTheme: vi.fn(),
      setFont: vi.fn(),
      zoomReset: vi.fn(),
      replayTour: vi.fn(),
    },
    ...over,
  };
}

describe("buildCommands", () => {
  it("puts the marquee action first", () => {
    expect(buildCommands(deps())[0].id).toBe("draft-new");
  });
  it("maps exactly the surfaces it is handed — a manifest-hidden surface can't appear", () => {
    const d = deps();
    const surfaceIds = buildCommands(d)
      .filter((c) => c.id.startsWith("surface:"))
      .map((c) => c.id);
    expect(surfaceIds).toEqual(["surface:document", "surface:drafter"]);
  });
  it("marks the current surface instead of describing it", () => {
    const byId = new Map(buildCommands(deps()).map((c) => [c.id, c]));
    expect(byId.get("surface:document")?.detail).toBe("showing now");
    expect(byId.get("surface:drafter")?.detail).toBe("Prompt drafter");
  });
  it("routes a session command through openSession with its id", () => {
    const d = deps();
    const session = buildCommands(d).find((c) => c.id === "session:s1")!;
    expect(session.title).toContain("Ship the palette");
    expect(session.detail).toBe("redline");
    session.run();
    expect(d.actions.openSession).toHaveBeenCalledWith("s1");
  });
  it("routes theme and font picks with their closed-list names", () => {
    const d = deps();
    const all = buildCommands(d);
    all.find((c) => c.id === "theme:studio")!.run();
    expect(d.actions.setTheme).toHaveBeenCalledWith("studio");
    all.find((c) => c.id === "font:san-francisco")!.run();
    expect(d.actions.setFont).toHaveBeenCalledWith("san-francisco");
    expect(all.find((c) => c.id === "theme:terminal")?.detail).toBe("current");
  });
  it("hints layout commands with keymap caps", () => {
    const snap = buildCommands(deps()).find((c) => c.id === "snap-back")!;
    expect(snap.keys).toEqual(["⌘", "⇧", "0"]);
  });
  it("keeps groups contiguous so the palette's headers render once each", () => {
    const groups = buildCommands(deps()).map((c) => c.group);
    const runs = groups.filter((g, i) => i === 0 || groups[i - 1] !== g);
    expect(new Set(runs).size).toBe(runs.length);
  });
});

// Source invariants, landing.test.ts-style: the palette's load-bearing wiring
// is greppable, so pin it here instead of trusting review to catch a drift.
describe("palette wiring", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
  const palette = readFileSync(
    join(process.cwd(), "src/components/CommandPalette.tsx"),
    "utf8",
  );
  it("App renders the palette and dispatches both wired globals via keymap", () => {
    expect(app).toContain("<CommandPalette");
    expect(app).toContain("isPaletteKey(");
    expect(app).toContain("isSnapBackKey(");
  });
  it("the palette registers with the menu-overlay contract — the native webview must hide beneath it", () => {
    expect(palette).toContain("useMenuOverlay(open)");
  });
});

describe("tour wiring", () => {
  const tour = readFileSync(
    join(process.cwd(), "src/components/OnboardingTour.tsx"),
    "utf8",
  );
  const settings = readFileSync(
    join(process.cwd(), "src/components/SettingsMenu.tsx"),
    "utf8",
  );
  it("the shortcuts step reads the keymap registry, not a copy", () => {
    expect(tour).toContain("tourShortcuts()");
  });
  it("has the landing step", () => {
    expect(tour).toContain('id: "landing"');
    expect(tour).toContain('anchor: "landing"');
  });
  it("never anchors inside the Settings popover — those nodes only exist while it's open", () => {
    // The theme/mode pickers render inside SettingsMenu's open-gated popover;
    // steps about them must anchor the always-present settings trigger.
    expect(tour).not.toContain('anchor: "theme"');
    expect(tour).not.toContain('anchor: "mode"');
    expect(settings).toContain('data-tour="settings"');
  });
});
