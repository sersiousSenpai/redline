// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  effectiveShape,
  isImmersive,
  isImmersiveSurface,
  type ShapeFlags,
} from "./immersive";
import type { MainSurface } from "./mainSurface";

const ALL_SURFACES: MainSurface[] = [
  "document",
  "browser",
  "drafter",
  "review",
  "servers",
  "memory",
  "runs",
];

/** A user with everything open — the shape the overlay has to hide. */
const open: ShapeFlags = {
  sidebarCollapsed: false,
  paneCollapsed: false,
  paneFullscreen: false,
  docPinned: true,
};

describe("isImmersiveSurface", () => {
  it("is NO surface — the chrome stays put everywhere", () => {
    // The header and footer no longer leave on navigation, the browser
    // included. What the hiding cost: every trip between surfaces became a
    // re-layout as the bars went and came back; the header is the window-drag
    // region, so hiding it meant a hull rail reproducing both dragging and
    // traffic-light clearance; and the way back was a hover target at the
    // screen edge, which is a mode with no visible exit.
    for (const s of ALL_SURFACES) {
      expect(isImmersiveSurface(s)).toBe(false);
    }
  });
});

describe("isImmersive", () => {
  it("never holds, whatever the inputs say", () => {
    // The machinery below it is intact and inert: `effectiveShape` still
    // overlays rather than storing, which is the part that was hard to get
    // right, so turning a surface back on is one predicate — no snapshot to
    // restore and nothing stale to reconcile.
    expect(
      isImmersive({ surface: "browser", broken: false, enabled: true }),
    ).toBe(false);
  });

  it("never holds on the document", () => {
    expect(
      isImmersive({ surface: "document", broken: false, enabled: true }),
    ).toBe(false);
  });

  it("breaking out wins over the surface", () => {
    expect(
      isImmersive({ surface: "browser", broken: true, enabled: true }),
    ).toBe(false);
  });

  it("the manifest opt-out is a full no-op", () => {
    for (const s of ALL_SURFACES) {
      expect(isImmersive({ surface: s, broken: false, enabled: false })).toBe(
        false,
      );
    }
  });
});

describe("effectiveShape", () => {
  it("passes the persisted flags straight through when not immersive", () => {
    expect(effectiveShape(open, false)).toBe(open);
  });

  it("hides both side panes and the doc tile when immersive", () => {
    expect(effectiveShape(open, true)).toEqual({
      sidebarCollapsed: true,
      paneCollapsed: true,
      paneFullscreen: false,
      docPinned: false,
    });
  });

  it("masks a fullscreen pane — fullscreen is the opposite of hidden", () => {
    const eff = effectiveShape({ ...open, paneFullscreen: true }, true);
    expect(eff.paneFullscreen).toBe(false);
    expect(eff.paneCollapsed).toBe(true);
  });

  // The law the whole design rests on: the overlay can only ever take things
  // OFF the screen. If it could open something, entering a surface would
  // change the user's layout rather than just veil it.
  it("only ever hides — no input shape makes a hidden thing visible", () => {
    for (const bits of Array.from({ length: 16 }, (_, n) => n)) {
      const pref: ShapeFlags = {
        sidebarCollapsed: !!(bits & 1),
        paneCollapsed: !!(bits & 2),
        paneFullscreen: !!(bits & 4),
        docPinned: !!(bits & 8),
      };
      const eff = effectiveShape(pref, true);
      // Collapsed can only go from false → true; fullscreen and the doc pin
      // (both "more visible" when true) can only go from true → false.
      expect(eff.sidebarCollapsed || !pref.sidebarCollapsed).toBe(true);
      expect(eff.sidebarCollapsed).toBe(true);
      expect(eff.paneCollapsed).toBe(true);
      expect(eff.paneFullscreen && !pref.paneFullscreen).toBe(false);
      expect(eff.docPinned && !pref.docPinned).toBe(false);
    }
  });

  it("does not mutate the persisted flags it is handed", () => {
    const pref = { ...open };
    effectiveShape(pref, true);
    expect(pref).toEqual(open);
  });
});

describe("the narrow masks are gone (W4)", () => {
  it("leaves the side columns to the user: no surface hides the sidebar or the rail", async () => {
    const mod = (await import("./immersive")) as Record<string, unknown>;
    for (const gone of ["panelMask", "panelMaskFor", "platePaneMask", "maskPanels", "panelsMasked"]) expect(mod[gone]).toBeUndefined();
    // The whole-window overlay stays inert on every surface, so nothing is
    // taken off the screen on a visit.
    for (const s of ALL_SURFACES) expect(isImmersive({ surface: s, broken: false, enabled: true })).toBe(false);
    expect(effectiveShape(open, false)).toBe(open);
  });
});
