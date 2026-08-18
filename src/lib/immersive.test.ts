// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  effectiveShape,
  isImmersive,
  isImmersiveSurface,
  maskPanels,
  panelMask,
  panelMaskFor,
  panelsMasked,
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
  termCollapsed: false,
  termFullscreen: false,
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

  it("hides both side panes, the dock and the doc tile when immersive", () => {
    expect(effectiveShape(open, true)).toEqual({
      sidebarCollapsed: true,
      paneCollapsed: true,
      paneFullscreen: false,
      termCollapsed: true,
      termFullscreen: false,
      docPinned: false,
    });
  });

  it("masks a fullscreen pane and a fullscreen dock — fullscreen is the opposite of hidden", () => {
    const full: ShapeFlags = {
      ...open,
      paneFullscreen: true,
      termFullscreen: true,
    };
    const eff = effectiveShape(full, true);
    expect(eff.paneFullscreen).toBe(false);
    expect(eff.termFullscreen).toBe(false);
    expect(eff.paneCollapsed).toBe(true);
    expect(eff.termCollapsed).toBe(true);
  });

  // The law the whole design rests on: the overlay can only ever take things
  // OFF the screen. If it could open something, entering a surface would
  // change the user's layout rather than just veil it.
  it("only ever hides — no input shape makes a hidden thing visible", () => {
    for (const bits of Array.from({ length: 64 }, (_, n) => n)) {
      const pref: ShapeFlags = {
        sidebarCollapsed: !!(bits & 1),
        paneCollapsed: !!(bits & 2),
        paneFullscreen: !!(bits & 4),
        termCollapsed: !!(bits & 8),
        termFullscreen: !!(bits & 16),
        docPinned: !!(bits & 32),
      };
      const eff = effectiveShape(pref, true);
      // Collapsed can only go from false → true; fullscreen and the doc pin
      // (both "more visible" when true) can only go from true → false.
      expect(eff.sidebarCollapsed || !pref.sidebarCollapsed).toBe(true);
      expect(eff.sidebarCollapsed).toBe(true);
      expect(eff.paneCollapsed).toBe(true);
      expect(eff.termCollapsed).toBe(true);
      expect(eff.paneFullscreen && !pref.paneFullscreen).toBe(false);
      expect(eff.termFullscreen && !pref.termFullscreen).toBe(false);
      expect(eff.docPinned && !pref.docPinned).toBe(false);
    }
  });

  it("does not mutate the persisted flags it is handed", () => {
    const pref = { ...open };
    effectiveShape(pref, true);
    expect(pref).toEqual(open);
  });
});

describe("panelMaskFor", () => {
  it("leaves the document alone — it is what both panels are about", () => {
    expect(panelMaskFor("document")).toEqual({ sidebar: false, pane: false });
  });

  it("takes both panels on every surface with no document", () => {
    for (const s of ["browser", "drafter", "servers", "memory", "runs"] as const) {
      expect(panelMaskFor(s)).toEqual({ sidebar: true, pane: true });
    }
  });

  it("keeps the discussion pane on Code Review", () => {
    // Not a judgement call: entering review points the pane at the DIFF's
    // annotation thread, so masking it would hide the very comments the
    // surface exists to collect. The sessions list is still a list of plans.
    expect(panelMaskFor("review")).toEqual({ sidebar: true, pane: false });
  });

  it("covers every surface — a new one must decide, not default silently", () => {
    for (const s of ALL_SURFACES) {
      const m = panelMaskFor(s);
      expect(typeof m.sidebar).toBe("boolean");
      expect(typeof m.pane).toBe("boolean");
    }
  });
});

describe("panelMask", () => {
  const on = { surface: "browser" as const, broken: false, enabled: true, docPinned: false };

  it("holds on a non-document surface", () => {
    expect(panelMask(on)).toEqual({ sidebar: true, pane: true });
    expect(panelsMasked(panelMask(on))).toBe(true);
  });

  it("breaking out wins for the rest of the visit", () => {
    // The user reopened something by hand. The next selectSurface re-arms.
    expect(panelMask({ ...on, broken: true })).toEqual({ sidebar: false, pane: false });
  });

  it("the manifest opt-out turns it off everywhere", () => {
    for (const s of ALL_SURFACES) {
      expect(panelMask({ ...on, surface: s, enabled: false })).toEqual({
        sidebar: false,
        pane: false,
      });
    }
  });

  it("a pinned document keeps its panels", () => {
    // The panels are furniture only when there is no document beside the
    // surface. Pin one and they are about something on screen again.
    expect(panelMask({ ...on, docPinned: true })).toEqual({
      sidebar: false,
      pane: false,
    });
  });

  it("never masks the document surface", () => {
    expect(panelMask({ ...on, surface: "document" })).toEqual({
      sidebar: false,
      pane: false,
    });
  });
});

describe("maskPanels", () => {
  it("passes the shape through by identity when nothing is masked", () => {
    expect(maskPanels(open, { sidebar: false, pane: false })).toBe(open);
  });

  it("closes both panels and drops a fullscreen pane", () => {
    const full: ShapeFlags = { ...open, paneFullscreen: true };
    expect(maskPanels(full, { sidebar: true, pane: true })).toEqual({
      ...open,
      sidebarCollapsed: true,
      paneCollapsed: true,
      paneFullscreen: false,
    });
  });

  it("leaves the dock and the doc tile completely alone", () => {
    // This is the whole difference from `effectiveShape`: the header, the
    // footer and the terminal dock stay put. That is what was rejected as
    // re-layout jank, and it must not come back through this door.
    const eff = maskPanels(
      { ...open, termFullscreen: true },
      { sidebar: true, pane: true },
    );
    expect(eff.termCollapsed).toBe(false);
    expect(eff.termFullscreen).toBe(true);
    expect(eff.docPinned).toBe(true);
  });

  it("honours a half mask — Code Review keeps its pane open", () => {
    const eff = maskPanels(open, { sidebar: true, pane: false });
    expect(eff.sidebarCollapsed).toBe(true);
    expect(eff.paneCollapsed).toBe(false);
  });

  // The same law `effectiveShape` rests on, one tier narrower: the overlay can
  // only ever take things OFF the screen. If it could open something, entering
  // a surface would change the user's layout rather than veil part of it.
  it("only ever hides — no shape and no mask makes a hidden thing visible", () => {
    for (const bits of Array.from({ length: 64 }, (_, n) => n)) {
      const pref: ShapeFlags = {
        sidebarCollapsed: !!(bits & 1),
        paneCollapsed: !!(bits & 2),
        paneFullscreen: !!(bits & 4),
        termCollapsed: !!(bits & 8),
        termFullscreen: !!(bits & 16),
        docPinned: !!(bits & 32),
      };
      for (const mask of [
        { sidebar: false, pane: false },
        { sidebar: true, pane: false },
        { sidebar: false, pane: true },
        { sidebar: true, pane: true },
      ]) {
        const eff = maskPanels(pref, mask);
        expect(eff.sidebarCollapsed || !pref.sidebarCollapsed).toBe(true);
        expect(eff.paneCollapsed || !pref.paneCollapsed).toBe(true);
        expect(eff.paneFullscreen && !pref.paneFullscreen).toBe(false);
        // Untouched, always.
        expect(eff.termCollapsed).toBe(pref.termCollapsed);
        expect(eff.termFullscreen).toBe(pref.termFullscreen);
        expect(eff.docPinned).toBe(pref.docPinned);
      }
    }
  });

  it("does not mutate the shape it is handed", () => {
    const pref = { ...open };
    maskPanels(pref, { sidebar: true, pane: true });
    expect(pref).toEqual(open);
  });
});
