// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Immersive surfaces: the browser, Localhost, Memory, Runs, the Drafter and
// Code Review are full-bleed destinations that want the whole window, and the
// periphery around the main pane (sessions sidebar, discussion pane, terminal
// dock, doc pin, header, footer) letterboxes them. Entering one hides the
// periphery; leaving it puts back exactly what was there.
//
// The obvious build — snapshot the pane flags on entry, write them back on
// exit — is the hazard this codebase already legislated against twice
// (mainSurface.ts: "illegal states are unrepresentable"; paneLayout.ts's
// isLayoutAtRest: "a stored 'closed' bit would go stale the moment another
// flow forces a pane open"). ~18 programmatic set*Collapsed(false) sites can
// move the real layout while a snapshot sits frozen, and restore would then
// slam shut a pane something legitimately opened.
//
// So nothing here is stored. `effectiveShape` OVERLAYS the persisted flags:
// the persisted state is untouched the whole time the user is immersed, which
// makes "restore" not an operation at all — it is the overlay lifting. Enter →
// hidden; exit → precisely what you had; re-enter → hidden again.

import type { MainSurface } from "./mainSurface";

/** Surfaces that take the whole window.
 *
 *  NONE, deliberately. The header and footer stay put on every surface — the
 *  browser included.
 *
 *  What the hiding cost, in practice: navigating between surfaces became a
 *  re-layout as the bars left and came back, which read as jank on every trip;
 *  the header is the window-drag region, so hiding it meant swapping in a hull
 *  rail that had to reproduce both dragging and traffic-light clearance; and
 *  the way back was a hover target at the screen edge, which is a mode with no
 *  visible exit. A stable frame around a changing surface is worth more than
 *  the ~40px it costs.
 *
 *  The machinery below is intact and inert. `effectiveShape` still overlays
 *  rather than storing (which is the part that was hard to get right), so
 *  turning any surface back on is this one predicate — no snapshot to restore
 *  and nothing stale to reconcile. */
export function isImmersiveSurface(_s: MainSurface): boolean {
  return false;
}

export interface ImmersiveInput {
  surface: MainSurface;
  /** The user has explicitly reopened something on this visit. One flag, not
   *  one per pane: immersive hides, the user unhides, and the user wins for
   *  the rest of the visit. The next `selectSurface` re-arms it. */
  broken: boolean;
  /** `layout.immersive: false` in the workspace manifest turns the whole
   *  behavior off — the one-line escape for a workflow that depends on the
   *  discussion pane being there. */
  enabled: boolean;
}

export function isImmersive(i: ImmersiveInput): boolean {
  return i.enabled && !i.broken && isImmersiveSurface(i.surface);
}

/** The shell's shape flags — the same set `isLayoutAtRest` compares, minus the
 *  surface (which is the input, not an output, of the immersive rule). */
export interface ShapeFlags {
  sidebarCollapsed: boolean;
  paneCollapsed: boolean;
  paneFullscreen: boolean;
  termCollapsed: boolean;
  termFullscreen: boolean;
  docPinned: boolean;
}

/** What immersive masks the flags to. Every field is the HIDING value:
 *  collapsed panes are hidden, and a fullscreen pane is the opposite of
 *  hidden, so both fullscreens go false alongside their collapse. Immersive
 *  never opens anything and never writes — the persisted flags keep their own
 *  values underneath. */
const HIDDEN: ShapeFlags = {
  sidebarCollapsed: true,
  paneCollapsed: true,
  paneFullscreen: false,
  termCollapsed: true,
  termFullscreen: false,
  docPinned: false,
};

/** Overlay the persisted flags. Returns `pref` itself when not immersive, so
 *  the non-immersive path is byte-identical to reading the flags directly. */
export function effectiveShape(pref: ShapeFlags, immersive: boolean): ShapeFlags {
  return immersive ? { ...HIDDEN } : pref;
}

// ---- The narrow mask: the two side panels, and nothing else -----------------
//
// `isImmersiveSurface` takes the whole periphery — the chrome and the terminal
// dock included — and that is what was rejected (see its note). The two side
// panels earned it on their own, though, and for a reason that has nothing to
// do with screen real estate: the sessions sidebar is a DOCUMENT INDEX and the
// discussion pane is a PLAN'S MARGIN. On a surface with no document, one is a
// list of things you aren't looking at and the other is a margin with nothing
// to be beside. They aren't letterboxing the browser; they're furniture from
// another room.
//
// Same law as `effectiveShape`, and for the same reason: this is an OVERLAY.
// Nothing is stored, so "restore on return" is not an operation — it's the
// overlay lifting, and the persisted flags were never written while masked.

export interface PanelMask {
  sidebar: boolean;
  pane: boolean;
}

const NO_MASK: PanelMask = { sidebar: false, pane: false };

/** Which panels a surface hides, ignoring the gates. */
export function panelMaskFor(s: MainSurface): PanelMask {
  switch (s) {
    // The document IS the thing both panels are about.
    case "document":
      return NO_MASK;
    // Code Review is the exception, and it is not a judgement call: entering
    // it points the discussion pane at the DIFF's annotation thread
    // (`selectSurface` flips `discussionContext` on entry). Masking the pane
    // here would hide the very comments the surface exists to collect. The
    // sessions list is still a list of plans, so it still goes.
    case "review":
      return { sidebar: true, pane: false };
    default:
      return { sidebar: true, pane: true };
  }
}

export interface PanelMaskInput extends ImmersiveInput {
  /** The document is pinned alongside this surface, so the panels are about
   *  something on screen after all. Read from the EFFECTIVE shape, before
   *  masking — `maskPanels` never touches `docPinned`, so there is no cycle. */
  docPinned: boolean;
}

/** The mask actually in force: the surface's, unless a gate cancels it.
 *  Mirrors `isImmersive`, one tier narrower. */
export function panelMask(i: PanelMaskInput): PanelMask {
  if (!i.enabled || i.broken || i.docPinned) return NO_MASK;
  return panelMaskFor(i.surface);
}

/** True when this mask hides anything — what the "where did the panels go"
 *  hint is gated on. */
export function panelsMasked(m: PanelMask): boolean {
  return m.sidebar || m.pane;
}

/** Overlay the two panel flags. Returns `shape` by identity when the mask is
 *  empty, matching `effectiveShape`'s convention.
 *
 *  Only ever hides: collapse is OR'd (false → true, never the reverse), and a
 *  masked pane's fullscreen goes false because fullscreen is the opposite of
 *  hidden. `termCollapsed` / `termFullscreen` / `docPinned` pass through
 *  untouched — the dock and the doc tile are precisely what this does NOT
 *  take. */
export function maskPanels(shape: ShapeFlags, mask: PanelMask): ShapeFlags {
  if (!mask.sidebar && !mask.pane) return shape;
  return {
    ...shape,
    sidebarCollapsed: shape.sidebarCollapsed || mask.sidebar,
    paneCollapsed: shape.paneCollapsed || mask.pane,
    paneFullscreen: mask.pane ? false : shape.paneFullscreen,
  };
}
