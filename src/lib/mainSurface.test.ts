// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it } from "vitest";
import {
  DOC_PINNED_KEY,
  MAIN_SURFACE_KEY,
  legacyMainSurface,
  migrateMainSurfaceOnce,
} from "./mainSurface";

describe("legacyMainSurface", () => {
  it("defaults to the document", () => {
    expect(legacyMainSurface(false, false, false)).toBe("document");
  });

  it("maps each single open pane", () => {
    expect(legacyMainSurface(true, false, false)).toBe("review");
    expect(legacyMainSurface(false, true, false)).toBe("drafter");
    expect(legacyMainSurface(false, false, true)).toBe("browser");
  });

  it("applies precedence review > drafter > browser on stale multi-true state", () => {
    expect(legacyMainSurface(true, true, true)).toBe("review");
    expect(legacyMainSurface(false, true, true)).toBe("drafter");
  });
});

describe("migrateMainSurfaceOnce", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("no-ops on a fresh install (no legacy keys)", () => {
    migrateMainSurfaceOnce(localStorage);
    expect(localStorage.getItem(MAIN_SURFACE_KEY)).toBeNull();
    expect(localStorage.getItem(DOC_PINNED_KEY)).toBeNull();
  });

  it("derives the surface and doc pin from legacy keys, then deletes them", () => {
    localStorage.setItem("redline.browser.open", "true");
    localStorage.setItem("redline.doc.open", "true");
    localStorage.setItem("redline.drafter.open", "false");
    migrateMainSurfaceOnce(localStorage);
    expect(localStorage.getItem(MAIN_SURFACE_KEY)).toBe('"browser"');
    expect(localStorage.getItem(DOC_PINNED_KEY)).toBe("true");
    expect(localStorage.getItem("redline.browser.open")).toBeNull();
    expect(localStorage.getItem("redline.doc.open")).toBeNull();
    expect(localStorage.getItem("redline.drafter.open")).toBeNull();
  });

  it("does not pin the document when the surface is the document itself", () => {
    localStorage.setItem("redline.doc.open", "true");
    migrateMainSurfaceOnce(localStorage);
    expect(localStorage.getItem(MAIN_SURFACE_KEY)).toBe('"document"');
    expect(localStorage.getItem(DOC_PINNED_KEY)).toBe("false");
  });

  it("resolves stale multi-true state by precedence", () => {
    localStorage.setItem("redline.review.open", "true");
    localStorage.setItem("redline.browser.open", "true");
    migrateMainSurfaceOnce(localStorage);
    expect(localStorage.getItem(MAIN_SURFACE_KEY)).toBe('"review"');
  });

  it("is idempotent — a second run never overwrites the user's choice", () => {
    localStorage.setItem("redline.browser.open", "true");
    migrateMainSurfaceOnce(localStorage);
    localStorage.setItem(MAIN_SURFACE_KEY, '"drafter"');
    localStorage.setItem("redline.review.open", "true");
    migrateMainSurfaceOnce(localStorage);
    expect(localStorage.getItem(MAIN_SURFACE_KEY)).toBe('"drafter"');
  });

  it("tolerates malformed legacy values", () => {
    localStorage.setItem("redline.browser.open", "not-json{");
    migrateMainSurfaceOnce(localStorage);
    expect(localStorage.getItem(MAIN_SURFACE_KEY)).toBe('"document"');
  });
});
