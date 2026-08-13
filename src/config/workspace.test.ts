// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  currentLanding,
  defaultWorkspace,
  headerSurfaces,
  initialSurface,
  moveHeaderSurface,
  parseWorkspace,
  serializeWorkspace,
  setLanding,
  setSurfaceEnabled,
  surfaceEnabled,
  workspaceLayout,
  MAIN_SURFACE_DESCRIPTORS,
  TOGGLEABLE_SURFACES,
} from "./workspace";
import { canonicalLayout } from "../lib/paneLayout";

describe("workspace snapshot — default manifest reproduces today's UI", () => {
  // The pre-registry header hardcoded exactly this radio group, in this order,
  // with these labels and tooltips. An untouched install must render it
  // byte-identically. If this test breaks, the DEFAULT experience changed —
  // that's a product decision, not a refactor.
  it("pins the header surface tuple", () => {
    expect(
      headerSurfaces(defaultWorkspace()).map((d) => [d.id, d.label, d.title]),
    ).toEqual([
      ["document", "Document", "Show the document"],
      ["browser", "Browser", "Switch to the browser"],
      ["drafter", "Prompt Drafter", "Draft a new prompt"],
      ["review", "Code Review", "Review code changes"],
      ["servers", "Localhost", "See your local dev servers"],
      ["runs", "Runs", "Monitor runs and the work graph"],
    ]);
  });

  // The upgrade path for everyone who already customized their header: their
  // manifest's `order` predates "servers" entirely, and `headerSurfaces`
  // appends anything missing from it. Without that, adding a surface would
  // make it invisible to exactly the users who care most about the header.
  it("appends a surface a pre-existing manifest order never heard of", () => {
    const ws = parseWorkspace(
      '{"header":{"order":["document","review","browser","drafter"]}}',
    );
    expect(headerSurfaces(ws).map((d) => d.id)).toEqual([
      "document",
      "review",
      "browser",
      "drafter",
      "servers",
      "runs",
    ]);
    expect(surfaceEnabled(ws, "servers")).toBe(true);
  });

  // Memory is deliberately NOT in the radio group — its entry is the header
  // pill. A manifest that still carries it in its order (written while memory
  // was a radio button) must simply drop it, not crash or resurrect it.
  // Runs, by contrast, was PROMOTED to the radio group (08/12, when the
  // cross-project Work tab made it a daily destination) — a stale order that
  // names it now keeps its slot.
  it("drops the pill surface from a stale manifest order, keeps runs", () => {
    const ws = parseWorkspace(
      '{"header":{"order":["document","memory","runs","review"]}}',
    );
    expect(headerSurfaces(ws).map((d) => d.id)).toEqual([
      "document",
      "runs",
      "review",
      "browser",
      "drafter",
      "servers",
    ]);
  });

  it("enables every toggleable surface by default", () => {
    const ws = defaultWorkspace();
    for (const s of TOGGLEABLE_SURFACES) {
      expect(surfaceEnabled(ws, s)).toBe(true);
    }
  });

  it("lands on the persisted (last-used) surface by default", () => {
    expect(currentLanding(defaultWorkspace())).toBe("last");
    expect(initialSurface(defaultWorkspace(), "drafter")).toBe("drafter");
    expect(initialSurface(defaultWorkspace(), "document")).toBe("document");
  });

  it("an EMPTY manifest object behaves identically to the default", () => {
    expect(headerSurfaces({})).toEqual(headerSurfaces(defaultWorkspace()));
    for (const s of TOGGLEABLE_SURFACES) {
      expect(surfaceEnabled({}, s)).toBe(true);
    }
    expect(initialSurface({}, "review")).toBe("review");
  });
});

describe("parseWorkspace leniency", () => {
  it("bad JSON, non-objects, and null degrade to defaults", () => {
    for (const text of [null, undefined, "", "not json", "[1,2]", '"str"']) {
      expect(headerSurfaces(parseWorkspace(text))).toEqual(
        headerSurfaces(defaultWorkspace()),
      );
    }
  });

  it("preserves unknown keys through a read-modify-write", () => {
    const ws = parseWorkspace(
      '{"myNote":"hands off","surfaces":{"voice":false}}',
    );
    const next = setSurfaceEnabled(ws, "browser", false);
    expect(next.myNote).toBe("hands off");
    expect(surfaceEnabled(next, "voice")).toBe(false); // prior edit survives
    expect(surfaceEnabled(next, "browser")).toBe(false);
    expect(JSON.parse(serializeWorkspace(next)).myNote).toBe("hands off");
  });
});

describe("surface disabling", () => {
  it("removes the surface from the header composition", () => {
    const ws = setSurfaceEnabled(defaultWorkspace(), "browser", false);
    expect(headerSurfaces(ws).map((d) => d.id)).toEqual([
      "document",
      "drafter",
      "review",
      "servers",
      "runs",
    ]);
  });

  it("the document is not removable — hand-edits can't strand the app", () => {
    const ws = parseWorkspace('{"header":{"order":["browser","review"]}}');
    expect(headerSurfaces(ws).map((d) => d.id)).toContain("document");
  });

  it("a persisted surface that got disabled falls back to the document", () => {
    const ws = setSurfaceEnabled(defaultWorkspace(), "browser", false);
    expect(initialSurface(ws, "browser")).toBe("document");
  });

  it("only an explicit false disables — pre-surface manifests keep it on", () => {
    expect(surfaceEnabled({ surfaces: {} }, "voice")).toBe(true);
    expect(surfaceEnabled({ surfaces: { voice: true } }, "voice")).toBe(true);
    expect(surfaceEnabled({ surfaces: { voice: false } }, "voice")).toBe(
      false,
    );
  });
});

describe("header ordering", () => {
  it("manifest order wins; unknown names drop; missing surfaces append", () => {
    const ws = parseWorkspace(
      '{"header":{"order":["review","document","bogus","review"]}}',
    );
    expect(headerSurfaces(ws).map((d) => d.id)).toEqual([
      "review",
      "document",
      "browser",
      "drafter",
      "servers",
      "runs",
    ]);
  });

  it("moveHeaderSurface swaps one slot and no-ops at the edges", () => {
    const ws = defaultWorkspace();
    const moved = moveHeaderSurface(ws, "browser", 1);
    expect(headerSurfaces(moved).map((d) => d.id)).toEqual([
      "document",
      "drafter",
      "browser",
      "review",
      "servers",
      "runs",
    ]);
    expect(moveHeaderSurface(ws, "document", -1)).toBe(ws);
    expect(moveHeaderSurface(ws, "runs", 1)).toBe(ws);
  });

  it("a hidden surface keeps its slot for when it comes back", () => {
    let ws = moveHeaderSurface(defaultWorkspace(), "browser", 1);
    ws = setSurfaceEnabled(ws, "browser", false);
    expect(headerSurfaces(ws).map((d) => d.id)).toEqual([
      "document",
      "drafter",
      "review",
      "servers",
      "runs",
    ]);
    ws = setSurfaceEnabled(ws, "browser", true);
    expect(headerSurfaces(ws).map((d) => d.id)).toEqual([
      "document",
      "drafter",
      "browser",
      "review",
      "servers",
      "runs",
    ]);
  });
});

describe("landing", () => {
  it("a fixed landing beats the persisted surface", () => {
    const ws = setLanding(defaultWorkspace(), "drafter");
    expect(initialSurface(ws, "document")).toBe("drafter");
  });

  it("a per-project override beats the global landing", () => {
    const ws = parseWorkspace(
      '{"landing":"drafter","projects":{"/repo/a":{"landing":"review"}}}',
    );
    expect(initialSurface(ws, "document", "/repo/a")).toBe("review");
    expect(initialSurface(ws, "document", "/repo/b")).toBe("drafter");
    expect(initialSurface(ws, "document", null)).toBe("drafter");
  });

  it("an invalid landing value degrades to last-used", () => {
    const ws = parseWorkspace('{"landing":"outer-space"}');
    expect(initialSurface(ws, "browser")).toBe("browser");
  });

  it("a landing pointing at a disabled surface falls back to the document", () => {
    let ws = setLanding(defaultWorkspace(), "drafter");
    ws = setSurfaceEnabled(ws, "drafter", false);
    expect(initialSurface(ws, "browser")).toBe("document");
  });
});

describe("first-gesture materialization", () => {
  it("the first customization writes a fully spelled-out file", () => {
    const ws = setSurfaceEnabled({}, "voice", false);
    expect(ws.version).toBe(1);
    expect(ws.landing).toBe("last");
    expect(ws.header?.order).toEqual([
      "document",
      "browser",
      "drafter",
      "review",
      "servers",
      "runs",
    ]);
    for (const s of TOGGLEABLE_SURFACES) {
      expect(ws.surfaces?.[s]).toBe(s !== "voice");
    }
  });

  it("descriptor registry and toggleable list stay in sync", () => {
    // Every main surface except the document must be toggleable.
    for (const d of MAIN_SURFACE_DESCRIPTORS) {
      if (d.id === "document") continue;
      expect(TOGGLEABLE_SURFACES).toContain(d.id);
    }
  });
});

describe("layout overrides (snap-back canonical shape)", () => {
  it("absent or malformed blocks mean no overrides", () => {
    expect(workspaceLayout({})).toEqual({});
    expect(workspaceLayout({ layout: undefined })).toEqual({});
    expect(workspaceLayout({ layout: "wide" } as never)).toEqual({});
    expect(workspaceLayout({ layout: [280] } as never)).toEqual({});
    expect(workspaceLayout({ layout: null } as never)).toEqual({});
  });

  it("valid fields pass through; junk fields drop individually", () => {
    const ws = parseWorkspace(
      JSON.stringify({
        layout: {
          sidebar: 280,
          discussion: "360",
          terminal: -50,
          mystery: 12,
        },
      }),
    );
    expect(workspaceLayout(ws)).toEqual({ sidebar: 280 });
  });

  it("a hand-written manifest reshapes the canonical layout", () => {
    const ws = parseWorkspace(
      JSON.stringify({ layout: { sidebar: 300, terminal: 320 } }),
    );
    const c = canonicalLayout(1440, 900, workspaceLayout(ws));
    expect(c.sidebarWidth).toBe(300);
    expect(c.termHeight).toBe(320);
    expect(c.paneWidth).toBe(320); // untouched field keeps its default
  });

  it("the layout block survives a GUI gesture's read-modify-write", () => {
    const ws = parseWorkspace(
      JSON.stringify({ layout: { sidebar: 280 } }),
    );
    const rewritten = setLanding(ws, "drafter");
    expect(workspaceLayout(rewritten)).toEqual({ sidebar: 280 });
    // And it round-trips through serialization.
    const reparsed = parseWorkspace(serializeWorkspace(rewritten));
    expect(workspaceLayout(reparsed)).toEqual({ sidebar: 280 });
  });
});
