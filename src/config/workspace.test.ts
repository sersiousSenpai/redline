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
  projectKind,
  registerProject,
  serializeWorkspace,
  setLanding,
  setSurfaceEnabled,
  surfaceEnabled,
  workspaceLayout,
  workspaceImmersive,
  readWorkspaceCache,
  storeWorkspaceCache,
  MAIN_SURFACE_DESCRIPTORS,
  SURFACE_LABELS,
  TOGGLEABLE_SURFACES,
  WORKSPACE_CACHE_KEY,
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

  it("keeps chat OUT of the header radio group", () => {
    // Chat is a `MainSurface` and a toggleable one, but it earns no permanent
    // button — same treatment as memory. Its entries are contextual: the front
    // door's destination picker, and the recent-chat pills on the island. A
    // surface earns a header slot by being a daily destination, not by
    // shipping.
    const ids = headerSurfaces(defaultWorkspace()).map((d) => d.id);
    expect(ids).not.toContain("chat");
    expect(ids).not.toContain("memory");
    // …and it is still a surface a manifest can switch off.
    expect(TOGGLEABLE_SURFACES).toContain("chat");
    expect(SURFACE_LABELS.chat).toBe("Chat");
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

  // The immersive opt-out shares the `layout` block with the size overrides
  // but is a boolean, so each reader has to ignore the other's fields.
  it("the immersive opt-out reads leniently and stays out of the size overrides", () => {
    expect(workspaceImmersive({})).toBe(true);
    expect(workspaceImmersive({ layout: "wide" } as never)).toBe(true);
    expect(workspaceImmersive({ layout: null } as never)).toBe(true);
    expect(workspaceImmersive({ layout: { sidebar: 280 } })).toBe(true);
    // Only a literal false disables — a typo must not silently turn it off.
    expect(workspaceImmersive({ layout: { immersive: "no" } } as never)).toBe(
      true,
    );
    expect(workspaceImmersive({ layout: { immersive: 0 } } as never)).toBe(true);
    expect(workspaceImmersive({ layout: { immersive: false } })).toBe(false);
    // And the size reader ignores it.
    const ws = parseWorkspace(
      JSON.stringify({ layout: { sidebar: 280, immersive: false } }),
    );
    expect(workspaceLayout(ws)).toEqual({ sidebar: 280 });
    expect(workspaceImmersive(ws)).toBe(false);
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

describe("the project registry — projectKind / registerProject", () => {
  it("reads only the kind this build knows", () => {
    const ws = parseWorkspace(
      JSON.stringify({
        projects: {
          "/Users/me/pack": { kind: "extension" },
          "/Users/me/desk": { kind: "harness" },
          "/Users/me/app": {},
          "/Users/me/future": { kind: "hologram" },
        },
      }),
    );
    expect(projectKind(ws, "/Users/me/pack")).toBe("extension");
    expect(projectKind(ws, "/Users/me/desk")).toBe("harness");
    expect(projectKind(ws, "/Users/me/app")).toBeNull();
    // An unknown kind is a plain project, never an error.
    expect(projectKind(ws, "/Users/me/future")).toBeNull();
    expect(projectKind(ws, "/Users/me/unregistered")).toBeNull();
    expect(projectKind(ws, null)).toBeNull();
    expect(projectKind(defaultWorkspace(), "/anywhere")).toBeNull();
  });

  it("registers a plain project and an extension project", () => {
    let ws = defaultWorkspace();
    ws = registerProject(ws, "/Users/me/app");
    ws = registerProject(ws, "/Users/me/pack", "extension");
    expect(ws.projects?.["/Users/me/app"]).toEqual({});
    expect(projectKind(ws, "/Users/me/app")).toBeNull();
    expect(projectKind(ws, "/Users/me/pack")).toBe("extension");
  });

  it("preserves an existing entry's fields and unknown keys", () => {
    const ws = parseWorkspace(
      JSON.stringify({
        note: "hand-annotated",
        projects: {
          "/Users/me/pack": { landing: "drafter", starred: true },
        },
      }),
    );
    const next = registerProject(ws, "/Users/me/pack", "extension");
    expect(next.projects?.["/Users/me/pack"]).toMatchObject({
      landing: "drafter",
      starred: true,
      kind: "extension",
    });
    // Unknown top-level keys ride through the rewrite untouched.
    expect(next.note).toBe("hand-annotated");
    // And a round-trip through the serializer keeps all of it.
    const reread = parseWorkspace(serializeWorkspace(next));
    expect(projectKind(reread, "/Users/me/pack")).toBe("extension");
    expect(reread.note).toBe("hand-annotated");
  });

  it("never downgrades: a kindless registration keeps the existing kind", () => {
    let ws = registerProject(defaultWorkspace(), "/Users/me/pack", "extension");
    ws = registerProject(ws, "/Users/me/pack");
    expect(projectKind(ws, "/Users/me/pack")).toBe("extension");
  });

  it("does not disturb per-project landing resolution", () => {
    const ws = registerProject(
      setLanding(defaultWorkspace(), "browser"),
      "/Users/me/pack",
      "extension",
    );
    // The registry entry has no landing, so the global landing still wins.
    expect(initialSurface(ws, "document", "/Users/me/pack")).toBe("browser");
  });
});

describe("the paint cache — the manifest's first-frame mirror", () => {
  const storage = (init: Record<string, string> = {}): Storage => {
    const m = new Map(Object.entries(init));
    return {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k: string) => m.get(k) ?? null,
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => {
        m.delete(k);
      },
      setItem: (k: string, v: string) => {
        m.set(k, String(v));
      },
    } as Storage;
  };

  it("mirrors the last-loaded text and reads it back parsed", () => {
    const s = storage();
    storeWorkspaceCache(s, '{"version":1,"landing":"drafter"}');
    expect(readWorkspaceCache(s)?.landing).toBe("drafter");
  });

  it("no cache = null — a genuinely untouched install stays on defaults", () => {
    expect(readWorkspaceCache(storage())).toBeNull();
  });

  it("a deleted manifest clears the mirror instead of echoing forever", () => {
    const s = storage();
    storeWorkspaceCache(s, '{"version":1}');
    storeWorkspaceCache(s, null);
    expect(readWorkspaceCache(s)).toBeNull();
  });

  it("a corrupted mirror degrades to defaults, never an error", () => {
    const s = storage({ [WORKSPACE_CACHE_KEY]: "not json" });
    // parseWorkspace's leniency applies: bad text = default manifest.
    expect(readWorkspaceCache(s)).toEqual(defaultWorkspace());
  });
});
