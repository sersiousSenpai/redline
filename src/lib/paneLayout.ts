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
/** Width of one vertical PaneDivider. */
export const DIVIDER_W = 6;

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
  const available = Math.max(0, i.winWidth - dividers);
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
