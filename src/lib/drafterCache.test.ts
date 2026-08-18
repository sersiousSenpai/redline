// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/react";

import {
  clearDrafterShadow,
  drafterShadowKey,
  readDrafterShadow,
  resolveDraftOpen,
  resolveDrafterMountDoc,
  writeDrafterFlush,
  type DrafterSessionEntry,
  type DrafterShadow,
  type ShadowStorage,
} from "./drafterCache";

const doc: JSONContent = { type: "doc", content: [] };
const entry = (at: number): DrafterSessionEntry => ({
  json: doc,
  projectPath: null,
  at,
});

describe("resolveDraftOpen", () => {
  it("a session entry wins outright — even over a newer shadow", () => {
    // The shadow may be mid-flight (written, not yet DB-confirmed); the cache
    // is what it shadows, so prompting here would be a false alarm.
    expect(resolveDraftOpen(entry(1000), 500, 2000)).toBe("session");
  });

  it("with no entry, a shadow strictly newer than the DB row prompts", () => {
    expect(resolveDraftOpen(null, 500, 501)).toBe("shadow-prompt");
  });

  it("a shadow at or behind the DB row defers to the DB", () => {
    expect(resolveDraftOpen(null, 500, 500)).toBe("db");
    expect(resolveDraftOpen(null, 500, 499)).toBe("db");
  });

  it("no DB row yet (updatedAt 0) — any shadow prompts", () => {
    expect(resolveDraftOpen(null, 0, 1)).toBe("shadow-prompt");
  });

  it("nothing anywhere → db (opens blank)", () => {
    expect(resolveDraftOpen(null, 0, null)).toBe("db");
  });
});

const memStorage = (): ShadowStorage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

describe("drafter shadow helpers", () => {
  it("round-trips a shadow through its storage key", () => {
    const s = memStorage();
    const shadow: DrafterShadow = { json: doc, markdown: "# hi", at: 42 };
    s.setItem(drafterShadowKey("d1"), JSON.stringify(shadow));
    expect(readDrafterShadow("d1", s)).toEqual(shadow);
    expect(readDrafterShadow("d2", s)).toBeNull();
  });

  it("corrupt JSON and shape-less payloads read as null", () => {
    const s = memStorage();
    s.setItem(drafterShadowKey("d1"), "{not json");
    expect(readDrafterShadow("d1", s)).toBeNull();
    // A payload without `at`/`json` is not a shadow, whatever wrote it.
    s.setItem(drafterShadowKey("d1"), JSON.stringify({ markdown: "x" }));
    expect(readDrafterShadow("d1", s)).toBeNull();
  });

  it("clear removes exactly the one document's shadow", () => {
    const s = memStorage();
    s.setItem(
      drafterShadowKey("d1"),
      JSON.stringify({ json: doc, markdown: "", at: 1 }),
    );
    s.setItem(
      drafterShadowKey("d2"),
      JSON.stringify({ json: doc, markdown: "", at: 2 }),
    );
    clearDrafterShadow("d1", s);
    expect(readDrafterShadow("d1", s)).toBeNull();
    expect(readDrafterShadow("d2", s)).not.toBeNull();
  });
});

// The claim these cover — "the editor never mounts with stale or foreign
// content", and "a flush writes the shadow before it can await" — used to be
// pinned by `indexOf` assertions against App.tsx's SOURCE TEXT, which pass if
// you merely reorder the comments. They existed because the contract lived
// inside a 7,000-line component; the fix was extraction, and these are the real
// tests the extraction bought.

describe("resolveDrafterMountDoc", () => {
  const cache = () => new Map<string, DrafterSessionEntry>();

  it("prefers the session cache — it is strictly fresher than the load copy", () => {
    // Written unconditionally on every flush; `drafterLoaded` was written only
    // when the id still matched, so it can be behind by a whole document.
    const c = cache();
    const fresh: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };
    c.set("d1", { json: fresh, projectPath: null, at: 2 });
    expect(
      resolveDrafterMountDoc(c, { forId: "d1", doc }, "d1"),
    ).toEqual({ doc: fresh });
  });

  it("falls back to the load copy before any flush this session", () => {
    expect(resolveDrafterMountDoc(cache(), { forId: "d1", doc }, "d1")).toEqual({
      doc,
    });
  });

  it("never answers with another document's body", () => {
    // The mount hazard the id tag exists to make unrepresentable: TipTap
    // captures `content` once, at creation, so mounting the wrong body opens
    // someone else's document over a real one with no way back.
    const c = cache();
    c.set("d2", { json: doc, projectPath: null, at: 1 });
    expect(resolveDrafterMountDoc(c, { forId: "d2", doc }, "d1")).toBeNull();
  });

  it("is null when nothing is loaded yet — the host shows its loading state", () => {
    expect(resolveDrafterMountDoc(cache(), null, "d1")).toBeNull();
    expect(resolveDrafterMountDoc(cache(), { forId: "d1", doc }, null)).toBeNull();
  });

  it("survives a remount that changes no id — the whole reason it exists", () => {
    // The shelf toggle, a surface switch and the pinned-doc toggle all remount
    // the editor without changing the active id, so the load effect (keyed on
    // that id) cannot re-run. The cache is what answers.
    const c = cache();
    const typed: JSONContent = { type: "doc", content: [{ type: "heading" }] };
    c.set("d1", { json: typed, projectPath: null, at: 9 });
    const stale = { forId: "d1", doc };
    expect(resolveDrafterMountDoc(c, stale, "d1")).toEqual({ doc: typed });
    expect(resolveDrafterMountDoc(c, stale, "d1")).toEqual({ doc: typed });
  });
});

describe("writeDrafterFlush", () => {
  const deps = () => {
    const order: string[] = [];
    const map = new Map<string, string>();
    const cache = new Map<string, DrafterSessionEntry>();
    return {
      order,
      cache,
      storage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => {
          order.push("shadow");
          map.set(k, v);
        },
        removeItem: (k: string) => void map.delete(k),
      },
      deps() {
        return {
          storage: this.storage,
          cache: new Proxy(cache, {
            get(t, p) {
              if (p === "set") {
                return (k: string, v: DrafterSessionEntry) => {
                  order.push("cache");
                  return t.set(k, v);
                };
              }
              const v = Reflect.get(t, p);
              return typeof v === "function" ? v.bind(t) : v;
            },
          }) as Map<string, DrafterSessionEntry>,
          persist: async () => {
            order.push("db");
          },
          now: () => 7,
        };
      },
    };
  };

  it("writes the shadow, then the cache, then the DB — in that order", async () => {
    const d = deps();
    await writeDrafterFlush("d1", doc, "# hi", "/repo/x", d.deps());
    expect(d.order).toEqual(["shadow", "cache", "db"]);
  });

  it("lands the shadow SYNCHRONOUSLY, before anything can await", () => {
    // The guarantee: a hard kill between a keystroke and the DB write loses
    // nothing. If the shadow moved behind the await it would be worthless.
    const d = deps();
    void writeDrafterFlush("d1", doc, "# hi", null, d.deps());
    expect(d.order).toEqual(["shadow", "cache", "db"]);
    expect(readDrafterShadow("d1", d.storage)).toEqual({
      json: doc,
      markdown: "# hi",
      at: 7,
    });
  });

  it("caches the project the flush actually wrote, not the one on screen", async () => {
    const d = deps();
    await writeDrafterFlush("d1", doc, "x", "/repo/x", d.deps());
    expect(d.cache.get("d1")).toEqual({ json: doc, projectPath: "/repo/x", at: 7 });
  });

  it("still reaches the DB when storage is unavailable", async () => {
    // Quota or private mode kills the shadow, never the write.
    const order: string[] = [];
    await writeDrafterFlush("d1", doc, "x", null, {
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceeded");
        },
        removeItem: () => {},
      },
      cache: new Map(),
      persist: async () => void order.push("db"),
      now: () => 1,
    });
    expect(order).toEqual(["db"]);
  });
});

// The one claim that genuinely spans files and has no pure home: the editor's
// mount goes through the resolver above rather than reading a prop the
// component ignores after mount.
describe("drafter mount wiring", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("mounts from resolveDrafterMountDoc, and the keyed remount survives", () => {
    expect(app).toContain("resolveDrafterMountDoc(");
    expect(app).toContain("doc={drafterMount.doc}");
    // Load-bearing: TipTap captures content at creation.
    expect(app).toContain("key={drafterDraftId");
  });

  it("the persist no longer pushes a mount prop back at the editor", () => {
    // The write-only feedback loop: `setDrafterLoaded` on every 400ms debounce,
    // changing a prop `PromptDrafter` contractually ignores after mount and
    // defeating its memo() for nothing.
    const persist = app.indexOf("const drafterPersist");
    const end = app.indexOf("[drafterDraftId, drafterProject]", persist);
    expect(persist).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(persist);
    expect(app.slice(persist, end)).not.toContain("setDrafterLoaded(");
  });
});
