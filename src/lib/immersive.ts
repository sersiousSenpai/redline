// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Immersive surfaces: the browser, Localhost, Memory, the Drafter and
// Code Review are full-bleed destinations that want the whole window, and the
// periphery around the main pane (sessions sidebar, discussion pane, doc
// pin, header, footer) letterboxes them. Entering one hides the
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
  docPinned: boolean;
}

/** What immersive masks the flags to. Every field is the HIDING value:
 *  collapsed panes are hidden, and a fullscreen pane is the opposite of
 *  hidden, so its fullscreen goes false alongside its collapse. Immersive
 *  never opens anything and never writes — the persisted flags keep their own
 *  values underneath. */
const HIDDEN: ShapeFlags = {
  sidebarCollapsed: true,
  paneCollapsed: true,
  paneFullscreen: false,
  docPinned: false,
};

/** Overlay the persisted flags. Returns `pref` itself when not immersive, so
 *  the non-immersive path is byte-identical to reading the flags directly. */
export function effectiveShape(pref: ShapeFlags, immersive: boolean): ShapeFlags {
  return immersive ? { ...HIDDEN } : pref;
}

// The narrow masks that used to hide the sessions sidebar and the discussion
// pane on a surface with no document went with W4: every pane kind has rail
// tabs, and the sidebar is the workbench's way between sessions, so both
// columns stay however the user left them (⌘B / ⌘⌥B).
