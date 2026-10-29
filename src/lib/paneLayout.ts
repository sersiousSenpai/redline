// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** A door pane's hard stop (D40): its composer keeps ONE row of chips —
 *  harness · project · destination · History, then + 🎙 ↑ — inside the
 *  island's compact padding and the room's 24 px margins, and its headline
 *  one line. Every other pane kind's stop is `PANE_MIN_W` in
 *  workbench/model.ts. */
export const DOOR_MIN_W = 560;
/** The stage's hard stop when nothing on it says otherwise (D38): the
 *  centre column never draws narrower. The tab on screen sets the real
 *  floor (`stageMin`): its focused pane's minimum, or a split's panes at
 *  theirs. A side column that cannot keep its own minimum beside it folds
 *  (`workbench/poses.ts`); a hand-opened narrow column curtains over it. */
export const STAGE_MIN_W = 480;
/** Minimum useful document-column width — the stage's default hard stop.
 *  Below it the side columns shrink toward their own minimums first, and
 *  only a column opened by hand in its narrow regime slides OVER the doc
 *  like a curtain. */
export const DOC_MIN = STAGE_MIN_W;
/** On wide windows the absolute floor is stingy — a 480px doc strip in a
 *  3000px window reads as squeezed shut. The floor scales to a fraction of
 *  the window once that fraction beats the absolute minimum. */
export const DOC_MIN_FRAC = 0.2;
/** The effective stage floor for a window: the larger of the minimum (the
 *  tab on screen's, else DOC_MIN) and the window fraction. */
export function docMinFor(winWidth: number, min: number = DOC_MIN): number {
  return Math.max(min, Math.round(winWidth * DOC_MIN_FRAC));
}
/** The gap between two columns (D38): none. Sidebar, stage and rail meet on
 *  a 1px rule, never on a strip of hull. */
export const SHELL_GUTTER = 0;
/** The seam between two columns: one 1px rule in `--color-rule`, which IS
 *  the divider — PaneDivider's layout box is the rule, and its grab zone
 *  overhangs it on both sides without taking layout width. */
export const SEAM_W = 1;
/** The divider's layout width — the seam. One constant, so the drag math
 *  and the drawn rule can never disagree. */
export const DIVIDER_W = SEAM_W;
/** Window-edge inset (D38): none. The columns run to the window's edges; no
 *  card sits inset on a hull ring. Kept as a name because the space model
 *  (`computePaneLayout`) and the door's edge hit regions read it. */
export const SHELL_EDGE = 0;

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
/** Hand-edited overrides from the workspace manifest's `layout` block (see
 *  workspaceLayout in config/workspace.ts — GUI–file duality). */
export interface CanonicalOverrides {
  sidebar?: number;
  discussion?: number;
}

export interface CanonicalLayout {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  paneWidth: number;
  paneCollapsed: boolean;
  paneFullscreen: boolean;
  surface: "document";
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
  // Kept for its callers: the height only ever sized the bottom dock, which
  // is gone (terminals are centre tabs).
  _winHeight: number,
  overrides: CanonicalOverrides = {},
): CanonicalLayout {
  return {
    sidebarWidth: overrideOr(overrides.sidebar, winWidth, CANONICAL_SIDEBAR_W),
    sidebarCollapsed: false,
    paneWidth: overrideOr(overrides.discussion, winWidth, CANONICAL_PANE_W),
    paneCollapsed: false,
    paneFullscreen: false,
    surface: "document",
  };
}

/** The live layout flags that define the shell's SHAPE — which plates are
 *  open or fullscreen, and what the active tab shows (a document beside a
 *  surface is that surface: `workbench/view.ts`). Widths are deliberately
 *  not part of this: see isLayoutAtRest. */
export interface RestingShapeInput {
  sidebarCollapsed: boolean;
  paneCollapsed: boolean;
  paneFullscreen: boolean;
  surface: string;
}


/** Is the live layout already at the canonical resting shape? Drives the
 *  snap-back toggle: at rest, ⌘⇧0 closes the panes instead of re-snapping
 *  (messy → canonical → closed → canonical…). Derived, never stored — a
 *  stored "closed" bit would go stale the moment another flow forces a pane
 *  open (starting a comment reveals the discussion so its composer shows).
 *
 *  Shape flags ONLY, compared against the `canonical` object's fields (not
 *  literals, so this can never drift from canonicalLayout). Widths are
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
  /** What a collapsed right pane still reserves in flow: the rail's edge
   *  strip of tab icons (W4). Absent, a collapsed pane takes nothing. */
  paneEdgeW?: number;
  /** The same for a collapsed sidebar: its icon pose (D18). */
  sidebarEdgeW?: number;
  /** A floor for the document above `docMinFor`'s: a narrow window keeps a
   *  readable plan, and a side column opened over it there curtains rather
   *  than squeezing it (D18). */
  docMin?: number;
  /** The column the user opened by hand in its narrow regime: it alone
   *  curtains over the document, and the other column (in its default pose)
   *  stays in flow, taking only what the first cannot (D18). */
  overlayFirst?: "pane" | "sidebar";
  /** What the stage's tab asks (D40): its focused pane's minimum, or its
   *  split's panes at theirs. Given, it replaces DOC_MIN as the floor;
   *  unlike `docMin` it keeps the columns' fit. */
  stageMin?: number;
  /** Each open column's hard stop (D38). Given, and outside the narrow
   *  regime (no `docMin`), a stage short of its floor takes the room back
   *  from the columns first — the rail down to its minimum, then the
   *  sidebar — and only what is left becomes curtain. A column never draws
   *  below its minimum: one that cannot keep it folds (`workbench/poses`). */
  sidebarMin?: number;
  paneMin?: number;
}

export interface PaneLayout {
  /** Each open column's drawn width: its own width, less what the stage
   *  took back to keep its floor (never below the column's minimum). */
  sidebarW: number;
  paneW: number;
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
 *  widths are never written — a width that would squish the doc below its
 *  floor first gives the room back down to the column's minimum (when the
 *  minimums are given), and only what is left becomes overlay (curtain)
 *  instead of flow, retracting symmetrically as space frees. A fullscreen
 *  discussion pane is already an absolute overlay and contributes nothing. */
export function computePaneLayout(i: PaneLayoutInput): PaneLayout {
  let s = i.sidebarCollapsed ? 0 : i.sidebarWidth;
  let p = i.paneCollapsed || i.paneFullscreen ? 0 : i.paneWidth;
  // The sidebar divider always renders; the discussion divider is absent in
  // fullscreen (the pane's top-edge divider replaces it).
  const dividers = DIVIDER_W + (i.paneFullscreen ? 0 : DIVIDER_W);
  const edge = (i.paneCollapsed && !i.paneFullscreen ? (i.paneEdgeW ?? 0) : 0) + (i.sidebarCollapsed ? (i.sidebarEdgeW ?? 0) : 0);
  const available = Math.max(0, i.winWidth - dividers - 2 * SHELL_EDGE - edge);
  // Degrade gracefully below tiny window widths.
  const docTarget = Math.min(Math.max(docMinFor(i.winWidth, i.stageMin || DOC_MIN), i.docMin ?? 0), available);
  // Hard stops (D38): outside the narrow regime the columns give the stage
  // its floor back before anything curtains — the rail first, then the
  // sidebar, each down to its own minimum and no further.
  if (i.docMin === undefined) {
    let short = Math.max(0, s + p + docTarget - available);
    if (short > 0 && i.paneMin !== undefined && p > i.paneMin) {
      const give = Math.min(short, p - i.paneMin);
      p -= give;
      short -= give;
    }
    if (short > 0 && i.sidebarMin !== undefined && s > i.sidebarMin) {
      s -= Math.min(short, s - i.sidebarMin);
    }
  }
  const deficit = Math.max(0, s + p + docTarget - available);
  // Attribute the deficit proportionally to pane width, each side capped at
  // its own width. Both panes' visual rectangles are fixed by their widths
  // and the window edges regardless of the split — attribution only decides
  // which part of the doc stays uncovered.
  let paneOverlayPx = 0;
  let sidebarOverlayPx = 0;
  if (deficit > 0 && i.overlayFirst === "pane") {
    paneOverlayPx = Math.min(p, deficit);
    sidebarOverlayPx = Math.min(s, deficit - paneOverlayPx);
  } else if (deficit > 0 && i.overlayFirst === "sidebar") {
    sidebarOverlayPx = Math.min(s, deficit);
    paneOverlayPx = Math.min(p, deficit - sidebarOverlayPx);
  } else if (deficit > 0) {
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
    sidebarW: s,
    paneW: p,
    sidebarFlowW,
    paneFlowW,
    sidebarOverlayPx,
    paneOverlayPx,
    docFlowW,
    docVisibleW,
    curtainActive: sidebarOverlayPx > 0 || paneOverlayPx > 0,
  };
}
