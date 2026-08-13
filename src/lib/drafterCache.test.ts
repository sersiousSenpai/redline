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

// Source invariants — the caching layer is pure, but the correctness claim
// ("the editor never mounts with stale or foreign content") lives in App.tsx
// wiring. These pin the contract, house-style (cf. landing.test.ts).
describe("drafter cache wiring", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");

  it("the editor mount is gated on the loaded doc's id tag", () => {
    const gate = app.indexOf("drafterLoaded.forId !== drafterDraftId");
    const mount = app.indexOf("<PromptDrafter");
    expect(gate).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(gate);
    expect(app).toContain("doc={drafterLoaded");
    // The keyed remount is load-bearing: TipTap captures content at creation.
    expect(app).toContain("key={drafterDraftId");
  });

  it("drafterPersist: shadow first, then session cache, then the DB invoke", () => {
    const persist = app.indexOf("const drafterPersist");
    expect(persist).toBeGreaterThan(-1);
    const shadow = app.indexOf("drafterShadowKey(", persist);
    const cache = app.indexOf("drafterSessionCache.current.set(", persist);
    const db = app.indexOf("persistDraftDoc(", persist);
    expect(shadow).toBeGreaterThan(persist);
    expect(cache).toBeGreaterThan(shadow);
    expect(db).toBeGreaterThan(cache);
  });

  it("the load effect consults the session cache before the DB", () => {
    const cacheRead = app.indexOf("drafterSessionCache.current.get(");
    const dbRead = app.indexOf("loadDraftDoc(");
    expect(cacheRead).toBeGreaterThan(-1);
    expect(dbRead).toBeGreaterThan(cacheRead);
  });
});
