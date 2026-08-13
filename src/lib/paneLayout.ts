// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** Minimum useful document-column width. Below this the doc is an unreadable
 *  sliver, so instead of squishing further the encroaching side pane slides
 *  OVER the doc like a curtain and the doc floors here. */
export const DOC_MIN = 300;
/** On wide windows the absolute floor is stingy — a 300px doc strip in a
 *  2000px window reads as squeezed shut. The floor scales to a fraction of
 *  the window, so curtain mode engages while the doc is still readable. */
export const DOC_MIN_FRAC = 0.2;
/** The effective doc floor for a window: the larger of the absolute minimum
 *  and the window fraction. */
export function docMinFor(winWidth: number): number {
  return Math.max(DOC_MIN, Math.round(winWidth * DOC_MIN_FRAC));
}
/** Minimum useful document-strip HEIGHT above the terminal dock — the vertical
 *  twin of DOC_MIN/docMinFor, for the dock's tile-driven growth. `docMinFor`
 *  is a *width* rule and the wrong instrument for a vertical cap. */
export const DOC_MIN_H = 220;
/** On tall windows the absolute floor reads squeezed shut; scale it. */
export const DOC_MIN_H_FRAC = 0.2;
/** The effective document floor above the dock for a window: the larger of
 *  the absolute minimum and the window fraction. */
export function docMinHFor(winHeight: number): number {
  return Math.max(DOC_MIN_H, Math.round(winHeight * DOC_MIN_H_FRAC));
}
/** Width of one pane gutter — the strip of hull canvas between two plates.
 *  The gutter IS the divider: PaneDivider's layout box spans it, transparent at
 *  rest so the canvas shows through, painting a slim bar only on hover/drag. */
export const SHELL_GUTTER = 10;
/** Alias kept for call sites that mean "the divider's layout width" — the two
 *  names are one constant so drag math and the shell's gutters can never
 *  disagree. */
export const DIVIDER_W = SHELL_GUTTER;
/** Window-edge inset: the hull ring around the outer plates. Delivered as
 *  constant padding on the <main> container (never part of drag math) and
 *  subtracted from the row's available width here, so `computePaneLayout`
 *  stays the single source of the space model. */
export const SHELL_EDGE = 10;

/** Resting width of the docked voice panel ("Talk to the plan"). */
export const VOICE_PANE_W = 380;
/** Hard stop when dragging the voice panel narrower — below this its composer
 *  and transport row wrap into an unusable stack. */
export const VOICE_PANE_MIN = 300;
/** The plan strip that must survive beside a docked voice panel. Unlike the
 *  side panes, the voice panel never curtains: it lives INSIDE the document
 *  column, so instead of sliding over the doc it simply stops growing. */
export const VOICE_DOC_MIN = 360;

/** Widest the voice panel may get inside a document column of `docColW`.
 *  Bounded twice — it never takes more than 60% of the column, and it always
 *  leaves `VOICE_DOC_MIN` of readable document — then floored at its own
 *  minimum (clamped to the column) so a squeezed window still yields a usable
 *  panel rather than a negative width. */
export function voicePaneMaxW(docColW: number): number {
  const w = Math.max(0, docColW);
  const roomy = Math.min(w - VOICE_DOC_MIN, Math.round(w * 0.6));
  // No early return for w <= 0: an `if (w <= 0) return VOICE_PANE_MIN` would
  // make the cap JUMP from 300 at a 0px column down to 50 at a 50px one. Both
  // terms below rise with the column, so the cap is monotonic all the way down.
  return Math.max(Math.min(VOICE_PANE_MIN, w), roomy);
}

/* ── Canonical shape (A3) ──────────────────────────────────────────────────
   The resting arrangement: what a fresh install's doors open onto, and what
   ⌘⇧0 snaps back to. Reading preferences (zoom, wide mode, theme) and the
   voice panel are deliberately outside this model — voice is first-class,
   and snap-back must never kill an active discussion. */

export const CANONICAL_SIDEBAR_W = 240;
export const CANONICAL_PANE_W = 320;
/** The terminal rests at 30% of the window, floored where a shorter dock
 *  stops being a usable terminal. */
export const CANONICAL_TERM_MIN_H = 260;
export const CANONICAL_TERM_FRAC = 0.3;
/** Below this window height even the floored terminal crowds the document,
 *  so the canonical shape folds the dock. */
export const CANONICAL_TERM_COLLAPSE_H = 760;

/** Hand-edited overrides from the workspace manifest's `layout` block (see
 *  workspaceLayout in config/workspace.ts — GUI–file duality). */
export interface CanonicalOverrides {
  sidebar?: number;
  discussion?: number;
  terminal?: number;
}

export interface CanonicalLayout {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  paneWidth: number;
  paneCollapsed: boolean;
  paneFullscreen: boolean;
  termHeight: number;
  termCollapsed: boolean;
  termFullscreen: boolean;
  surface: "document";
  docPinned: boolean;
  splitRatio: number;
}

/** An override must still be a sane pane size ON THIS WINDOW — off-range
 *  values fall back to the built-in default. Leniency, not clamping: a
 *  hand-typed 5000 means a typo, not "as large as possible". */
function overrideOr(
  v: number | undefined,
  dim: number,
  fallback: number,
): number {
  return v !== undefined && v >= 120 && v <= Math.round(dim * 0.6)
    ? Math.round(v)
    : fallback;
}

/** Pure derivation of the canonical resting shape for a window. The boot
 *  target stays the user's persisted layout (restore-where-you-were); this
 *  is the snap-back target — and, defaults mirroring persisted defaults,
 *  what a fresh install boots into anyway. */
export function canonicalLayout(
  winWidth: number,
  winHeight: number,
  overrides: CanonicalOverrides = {},
): CanonicalLayout {
  return {
    sidebarWidth: overrideOr(overrides.sidebar, winWidth, CANONICAL_SIDEBAR_W),
    sidebarCollapsed: false,
    paneWidth: overrideOr(overrides.discussion, winWidth, CANONICAL_PANE_W),
    paneCollapsed: false,
    paneFullscreen: false,
    termHeight: overrideOr(
      overrides.terminal,
      winHeight,
      Math.max(
        CANONICAL_TERM_MIN_H,
        Math.round(winHeight * CANONICAL_TERM_FRAC),
      ),
    ),
    termCollapsed: winHeight < CANONICAL_TERM_COLLAPSE_H,
    termFullscreen: false,
    surface: "document",
    docPinned: false,
    splitRatio: 0.5,
  };
}

/** The live layout flags that define the shell's SHAPE — which plates are
 *  open, fullscreen, pinned, and which surface owns the pane. Widths are
 *  deliberately not part of this: see isLayoutAtRest. */
export interface RestingShapeInput {
  sidebarCollapsed: boolean;
  paneCollapsed: boolean;
  paneFullscreen: boolean;
  termCollapsed: boolean;
  termFullscreen: boolean;
  docPinned: boolean;
  surface: string;
}

/** Is the live layout already at the canonical resting shape? Drives the
 *  snap-back toggle: at rest, ⌘⇧0 closes the panes instead of re-snapping
 *  (messy → canonical → closed → canonical…). Derived, never stored — a
 *  stored "closed" bit would go stale the moment another flow forces a pane
 *  open (plan intercepts call setPaneCollapsed(false) directly).
 *
 *  Shape flags ONLY, compared against the `canonical` object's fields (not
 *  literals, so this can never drift from canonicalLayout — including the
 *  short-window case where canonical itself folds the terminal). Widths are
 *  deliberately excluded: a 5px divider nudge must not flip the button's
 *  meaning from "snap back" to "close everything". A width-drifted layout
 *  gets one "free" re-snap before the close — which is the right UX. */
export function isLayoutAtRest(
  current: RestingShapeInput,
  canonical: CanonicalLayout,
): boolean {
  return (
    current.sidebarCollapsed === canonical.sidebarCollapsed &&
    current.paneCollapsed === canonical.paneCollapsed &&
    current.paneFullscreen === canonical.paneFullscreen &&
    current.termCollapsed === canonical.termCollapsed &&
    current.termFullscreen === canonical.termFullscreen &&
    current.docPinned === canonical.docPinned &&
    current.surface === canonical.surface
  );
}

export interface PaneLayoutInput {
  winWidth: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  paneWidth: number;
  paneCollapsed: boolean;
  paneFullscreen: boolean;
}

export interface PaneLayout {
  /** In-flow px each side pane's clip wrapper reserves. */
  sidebarFlowW: number;
  paneFlowW: number;
  /** Px each pane paints OVER the doc (its curtain overage). 0 = normal. */
  sidebarOverlayPx: number;
  paneOverlayPx: number;
  /** Doc column flow width (what flex-1 resolves to). */
  docFlowW: number;
  /** The doc strip not covered by any curtain. */
  docVisibleW: number;
  curtainActive: boolean;
}

/** Stateless derivation of the main row's space model. The persisted pane
 *  widths are never clamped — a width that would squish the doc below
 *  DOC_MIN simply becomes overlay (curtain) instead of flow, so dragging
 *  stays continuous and retracts symmetrically as space frees. A fullscreen
 *  discussion pane is already an absolute overlay and contributes nothing. */
export function computePaneLayout(i: PaneLayoutInput): PaneLayout {
  const s = i.sidebarCollapsed ? 0 : i.sidebarWidth;
  const p = i.paneCollapsed || i.paneFullscreen ? 0 : i.paneWidth;
  // The sidebar divider always renders; the discussion divider is absent in
  // fullscreen (the pane's top-edge divider replaces it).
  const dividers = DIVIDER_W + (i.paneFullscreen ? 0 : DIVIDER_W);
  const available = Math.max(0, i.winWidth - dividers - 2 * SHELL_EDGE);
  // Degrade gracefully below tiny window widths.
  const docTarget = Math.min(docMinFor(i.winWidth), available);
  const deficit = Math.max(0, s + p + docTarget - available);
  // Attribute the deficit proportionally to pane width, each side capped at
  // its own width. Both panes' visual rectangles are fixed by their widths
  // and the window edges regardless of the split — attribution only decides
  // which part of the doc stays uncovered.
  let paneOverlayPx = 0;
  let sidebarOverlayPx = 0;
  if (deficit > 0) {
    paneOverlayPx = Math.min(p, Math.round((deficit * p) / Math.max(1, s + p)));
    sidebarOverlayPx = Math.min(s, deficit - paneOverlayPx);
    // If one side couldn't absorb its share, the other takes the remainder.
    paneOverlayPx = Math.min(p, deficit - sidebarOverlayPx);
  }
  const sidebarFlowW = s - sidebarOverlayPx;
  const paneFlowW = p - paneOverlayPx;
  const docFlowW = Math.max(0, available - sidebarFlowW - paneFlowW);
  const docVisibleW = Math.max(0, docFlowW - sidebarOverlayPx - paneOverlayPx);
  return {
    sidebarFlowW,
    paneFlowW,
    sidebarOverlayPx,
    paneOverlayPx,
    docFlowW,
    docVisibleW,
    curtainActive: sidebarOverlayPx > 0 || paneOverlayPx > 0,
  };
}
