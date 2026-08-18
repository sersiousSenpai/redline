// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIRST_PARTY_HARNESSES,
  exitHidden,
  harnessHeaderSurfaces,
  harnessWorkspace,
  parseHarnessManifest,
  readActiveHarness,
  readHarnessArrangement,
  resolveHarnesses,
  storeActiveHarness,
  storeHarnessArrangement,
  type ActiveHarness,
} from "./harness";
import { headerSurfaces, initialSurface } from "../config/workspace";

function fakeStorage(init: Record<string, string> = {}): Storage {
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
}

describe("parseHarnessManifest — lenient like every user-authored file", () => {
  it("parses a minimal manifest and defaults the workspace block", () => {
    const m = parseHarnessManifest('{"id":"x","name":"X"}');
    expect(m).not.toBeNull();
    expect(m!.id).toBe("x");
    expect(m!.workspace).toEqual({});
  });
  it("rejects what is not a harness, never throws", () => {
    expect(parseHarnessManifest(null)).toBeNull();
    expect(parseHarnessManifest("")).toBeNull();
    expect(parseHarnessManifest("not json")).toBeNull();
    expect(parseHarnessManifest("[1]")).toBeNull();
    expect(parseHarnessManifest('{"name":"X"}')).toBeNull();
    expect(parseHarnessManifest('{"id":" ","name":"X"}')).toBeNull();
    expect(parseHarnessManifest('{"id":"x","name":""}')).toBeNull();
  });
  it("degrades a malformed workspace block to defaults, keeps unknown keys", () => {
    const m = parseHarnessManifest(
      '{"id":"x","name":"X","workspace":[1],"theme":"noir","future":{"k":1}}',
    );
    expect(m!.workspace).toEqual({});
    // `theme` is RESERVED (open decision 8 deferred): carried, never read.
    expect(m!.theme).toBe("noir");
    expect(m!.future).toEqual({ k: 1 });
  });
});

describe("the first-party fixture", () => {
  const desk = FIRST_PARTY_HARNESSES.find((h) => h.id === "writing-desk")!;
  it("exists and survives its own serialization round trip", () => {
    expect(desk).toBeTruthy();
    const reparsed = parseHarnessManifest(JSON.stringify(desk));
    expect(reparsed).toEqual(desk);
  });
  it("exercises every axis the mechanism swaps", () => {
    const ws = harnessWorkspace(desk);
    // Surface removal + reorder…
    expect(headerSurfaces(ws).map((d) => d.id)).toEqual([
      "document",
      "drafter",
    ]);
    // …relabel…
    expect(
      harnessHeaderSurfaces(ws, desk).map((d) => [d.id, d.label]),
    ).toEqual([
      ["document", "Document"],
      ["drafter", "Desk"],
    ]);
    // …landing…
    expect(initialSurface(ws, "document")).toBe("drafter");
    // …and the hero.
    expect(desk.hero?.eyebrow).toBe("Writing Desk");
  });
});

describe("resolveHarnesses", () => {
  it("offers fixtures, lets an installed copy shadow by id", () => {
    const out = resolveHarnesses([
      {
        id: "writing-desk",
        json: '{"id":"writing-desk","name":"My Desk"}',
      },
      { id: "legal", json: '{"id":"legal","name":"Legal"}' },
    ]);
    expect(out.find((h) => h.id === "writing-desk")!.name).toBe("My Desk");
    expect(out.map((h) => h.id)).toContain("legal");
  });
  it("skips a manifest whose id disagrees with its folder", () => {
    const out = resolveHarnesses([
      { id: "legal", json: '{"id":"other","name":"Confused"}' },
    ]);
    expect(out.some((h) => h.name === "Confused")).toBe(false);
  });
});

describe("harnessWorkspace — the user's arrangement layers over the pack", () => {
  const desk = FIRST_PARTY_HARNESSES[0];
  it("no delta = the harness's defaults", () => {
    expect(harnessWorkspace(desk)).toBe(desk.workspace);
  });
  it("the delta wins per key, merging surface maps", () => {
    const ws = harnessWorkspace(desk, {
      landing: "document",
      surfaces: { review: true },
    });
    expect(ws.landing).toBe("document");
    // Re-enabled by the user's own gesture…
    expect(ws.surfaces?.review).toBe(true);
    // …while the harness's other removals stand.
    expect(ws.surfaces?.browser).toBe(false);
  });
});

describe("harness mode cannot strand a surface — the held plan's home", () => {
  const desk = FIRST_PARTY_HARNESSES[0];
  it("the document survives ANY harness manifest, even a hostile one", () => {
    const hostile = parseHarnessManifest(
      '{"id":"h","name":"H","workspace":{"surfaces":{"document":false},"header":{"order":["browser"]}}}',
    )!;
    const ids = headerSurfaces(harnessWorkspace(hostile)).map((d) => d.id);
    expect(ids).toContain("document");
  });
  it("a landing the harness hides falls back to the document", () => {
    const m = parseHarnessManifest(
      '{"id":"h","name":"H","workspace":{"surfaces":{"browser":false},"landing":"browser"}}',
    )!;
    expect(initialSurface(harnessWorkspace(m), "browser")).toBe("document");
  });
  it("unknown surface ids in a manifest degrade to nothing", () => {
    const m = parseHarnessManifest(
      '{"id":"h","name":"H","workspace":{"header":{"order":["contracts","document"]},"landing":"contracts"},"labels":{"contracts":{"label":"Contracts"}}}',
    )!;
    const ws = harnessWorkspace(m);
    expect(headerSurfaces(ws).map((d) => String(d.id))).not.toContain(
      "contracts",
    );
    expect(initialSurface(ws, "document")).toBe("document");
    expect(() => harnessHeaderSurfaces(ws, m)).not.toThrow();
  });
  it("entering the fixture from a hidden surface evicts to the document", () => {
    // The App effect's exact predicate: standing on a surface the effective
    // manifest disables sends you to the document.
    const ws = harnessWorkspace(desk);
    expect(initialSurface(ws, "review")).toBe("drafter");
    expect(headerSurfaces(ws).some((d) => d.id === "review")).toBe(false);
  });
});

describe("active-harness persistence — flavor-split, paint-cache semantics", () => {
  const desk = FIRST_PARTY_HARNESSES[0];
  it("round-trips entry, manifest and return surface", () => {
    const s = fakeStorage();
    const active: ActiveHarness = {
      manifest: desk,
      entry: "user",
      returnSurface: "browser",
    };
    storeActiveHarness(s, active);
    expect(readActiveHarness(s)).toEqual(active);
    storeActiveHarness(s, null);
    expect(readActiveHarness(s)).toBeNull();
  });
  it("a boot entry round-trips and derives a hidden exit", () => {
    const s = fakeStorage();
    storeActiveHarness(s, { manifest: desk, entry: "boot" });
    const back = readActiveHarness(s)!;
    expect(back.entry).toBe("boot");
    expect(exitHidden(back)).toBe(true);
    expect(exitHidden({ manifest: desk, entry: "user" })).toBe(false);
  });
  it("corrupted or alien cache contents read as no harness", () => {
    expect(
      readActiveHarness(fakeStorage({ "redline.harness.active": "junk" })),
    ).toBeNull();
    expect(
      readActiveHarness(
        fakeStorage({ "redline.harness.active": '{"entry":"user"}' }),
      ),
    ).toBeNull();
  });
  it("arrangements persist per harness id", () => {
    const s = fakeStorage();
    storeHarnessArrangement(s, "a", { landing: "document" });
    storeHarnessArrangement(s, "b", { landing: "drafter" });
    expect(readHarnessArrangement(s, "a")).toEqual({ landing: "document" });
    expect(readHarnessArrangement(s, "b")).toEqual({ landing: "drafter" });
    expect(readHarnessArrangement(s, "c")).toEqual({});
  });
});

// The held-plan invariant (#3), pinned structurally. A held ExitPlanMode
// plan is a POST the daemon is holding; only a command could touch it.
// Harness entry/exit is pure recomposition — so the strongest FE guarantee
// is an import/call ban: neither this module nor App's enter/exit callbacks
// may reach the daemon. The live walk (enter with a hold open, exit, resolve
// the hold) belongs to the phase's GUI gate.
describe("held-plan invariant — entry and exit cannot reach the daemon", () => {
  it("the harness module imports no IPC", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/harness.ts"), "utf8");
    expect(src.includes("@tauri-apps")).toBe(false);
    expect(src.includes("invoke(")).toBe(false);
    expect(src.includes("fetch(")).toBe(false);
  });
  it("App's enterHarness/exitHarness call no command", () => {
    const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
    const start = app.indexOf("const enterHarness = useCallback");
    const end = app.indexOf(
      "// Hiding a surface you're standing on",
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const callbacks = app.slice(start, end);
    expect(callbacks.includes("invoke(")).toBe(false);
    expect(callbacks.includes("fetch(")).toBe(false);
  });
});
