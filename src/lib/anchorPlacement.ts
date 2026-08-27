// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Where an overlay that points at something in the document should actually go.
//
// Three lies this replaces, all of them in the drafter's four hand-rolled
// `position: fixed` overlays:
//
//  1. **Clamping instead of flipping.** Every one of them did
//     `top: Math.max(8, anchorTop - 36)`. Near the top of the pane that pins
//     the panel over the ribbon while it still claims to point at a paragraph
//     four lines down. The fix is to FLIP to the other side of the anchor —
//     which is what a reader expects and what every real popover does.
//
//  2. **Bounds that are the viewport.** `popover.tsx` clamps to
//     `window.innerWidth`, which is right for a header menu and wrong inside a
//     split pane: an overlay is allowed to run to the edge of the *window*
//     while its anchor's pane is 400px wide, so it lands over the browser.
//
//  3. **Pretending an off-screen anchor is on-screen.** Scroll the anchor out
//     of the pane and the overlay clamps to the edge, hovering there pointing
//     at nothing. `visible: false` says so, and the caller unmounts.

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlaceOptions {
  /** The box the overlay must stay inside — the PANE, not the viewport. */
  bounds: AnchorRect;
  /** Preferred side. Flips to the other one when there isn't room. */
  prefer?: "above" | "below";
  /** Distance between the anchor edge and the overlay edge. */
  gap?: number;
  /** Keep-out margin from the bounds' edges. */
  margin?: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Which side it actually landed on — the caller points its tail this way. */
  side: "above" | "below";
  /** False when the anchor has scrolled out of `bounds`. An overlay whose
   *  anchor isn't on screen must UNMOUNT, not hover at the edge. */
  visible: boolean;
  /** How tall the overlay may actually be on the side it landed on — the room
   *  that is really there (`roomBelow - gap - margin`, or `roomAbove - …`),
   *  floored so it is never budgeted to nothing.
   *
   *  This is the fourth lie: a panel that caps itself at `60vh` is quoting a
   *  fraction of the WINDOW, which has nothing to do with the room left below
   *  its anchor. A tile low in the grid gets 280px of room and lays out 540px,
   *  and because the panel is `position: fixed` nothing can scroll the overhang
   *  back — the rows rendered last are simply unreachable. Give the panel's
   *  scroller THIS number instead and the overflow becomes scrollable.
   *
   *  Additive: `left`/`top`/`side`/`visible` are unchanged by its arrival, so
   *  callers that ignore it (AnchoredOverlay) keep their behaviour exactly. */
  maxHeight: number;
}

const DEFAULT_GAP = 8;
const DEFAULT_MARGIN = 8;
/** Below this a "budget" is no longer a budget, it is a sliver. When both sides
 *  are this cramped the viewport itself is the problem and a scrollable stub
 *  beats a zero-height panel. */
const MIN_BUDGET = 96;

/** Place `size` against `target`, inside `bounds`. Coordinates in and out are
 *  viewport coordinates (what `getBoundingClientRect` gives you), so the caller
 *  can write them straight to a `position: fixed` element. */
export function placeByRect(
  target: AnchorRect,
  size: { width: number; height: number },
  opts: PlaceOptions,
): Placement {
  const gap = opts.gap ?? DEFAULT_GAP;
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const { bounds } = opts;
  const prefer = opts.prefer ?? "above";

  // Is the anchor still inside the box it belongs to? A strictly-outside
  // anchor means the overlay is pointing at something nobody can see.
  const visible =
    target.bottom > bounds.top &&
    target.top < bounds.bottom &&
    target.right > bounds.left &&
    target.left < bounds.right;

  // FLIP, don't clamp: take the preferred side if it fits, otherwise the other
  // one, otherwise whichever has more room.
  const roomAbove = target.top - bounds.top;
  const roomBelow = bounds.bottom - target.bottom;
  const needed = size.height + gap + margin;
  let side: "above" | "below";
  if (prefer === "above") {
    side = roomAbove >= needed ? "above" : roomBelow >= needed ? "below" : roomAbove >= roomBelow ? "above" : "below";
  } else {
    side = roomBelow >= needed ? "below" : roomAbove >= needed ? "above" : roomBelow >= roomAbove ? "below" : "above";
  }

  const rawTop =
    side === "above" ? target.top - gap - size.height : target.bottom + gap;
  // Only NOW is clamping honest — the side is already the one with room, so
  // this is the last few pixels, not a lie about where the anchor is.
  const top = clamp(rawTop, bounds.top + margin, bounds.bottom - size.height - margin);

  // Horizontally: start at the anchor's left edge and keep the whole overlay
  // inside the pane.
  const left = clamp(
    target.left,
    bounds.left + margin,
    bounds.right - size.width - margin,
  );

  // The height budget is the room on the side we actually landed on — not a
  // viewport fraction, and not `size.height`, which is what the panel WANTED.
  const maxHeight = Math.max(
    MIN_BUDGET,
    (side === "above" ? roomAbove : roomBelow) - gap - margin,
  );

  return { left, top, side, visible, maxHeight };
}

function clamp(v: number, lo: number, hi: number): number {
  // A bounds box narrower than the overlay would invert lo/hi; pinning to `lo`
  // keeps the overlay's own left/top edge on screen, which is the readable
  // half.
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(v, hi));
}

/** The window as an `AnchorRect`. A header menu's bounds ARE the viewport —
 *  lie #2 above is about overlays *inside a pane* borrowing these bounds, not
 *  about the menus for which they are correct. Shared so viewport-anchored
 *  menus and pane-anchored overlays go through one function. */
export function viewportBounds(): AnchorRect {
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
}

/** A DOMRect-ish from an element, or null. Kept here so callers don't each
 *  re-derive the same four numbers. */
export function rectOf(el: Element | null | undefined): AnchorRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}
