// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Springing one surface open from another, without merging them.
//
// The Front Door and the Prompt Drafter stay separate components that know
// nothing about each other. What persists across the swap is not a component —
// it is this transition, which App owns. Both surfaces are mounted for its
// duration, stacked: the door fades back, the drafter springs forward from
// exactly the box the island occupied.
//
// It animates `transform` and nothing else, which is the lesson from three
// failed attempts. A `clip-path` aperture on the incoming surface does not work
// at all, because WebKit gives a `backdrop-filter` element its own compositing
// layer that an ancestor clip does not reliably reach — and the Drafter is made
// of backdrop-filter. A transform IS the compositor's native operation. It also
// lets the spring overshoot, which `inset()` cannot: an overshooting curve
// drives an inset negative, it clamps at zero, and the motion reads as a stall.

export interface SwapRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Long enough that the settle is legible as a settle. The reference is the
 *  Dynamic Island: it covers the distance early and spends the tail easing,
 *  which is what makes a size change read as an object arriving. */
export const SWAP_MS = 620;

/** A gentle back-out. The overshoot past 1 is the spring — small, because the
 *  thing that is overshooting is a full-pane surface, and at that size even 2%
 *  is a visible bounce. */
export const SWAP_SPRING = "cubic-bezier(0.34, 1.28, 0.64, 1)";

/** The outgoing door's curve. Symmetric and quick: it is getting out of the
 *  way, not performing. */
export const SWAP_OUT_EASING = "cubic-bezier(0.4, 0, 0.6, 1)";

/** The transform that makes `host` sit exactly on `from`.
 *
 *  This is the "Invert" of a FLIP. `transform-origin` is the host's top-left
 *  (set by the component), so the translate is a plain corner-to-corner delta
 *  and the scale is a straight ratio — no centre arithmetic to get subtly
 *  wrong, which is what makes this checkable by eye in a test. */
export function inverseTransform(from: SwapRect, host: SwapRect): string {
  if (host.width <= 0 || host.height <= 0) return "none";
  const sx = from.width / host.width;
  const sy = from.height / host.height;
  const dx = from.left - host.left;
  const dy = from.top - host.top;
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(sx, 4)}, ${round(sy, 4)})`;
}

/** Is this worth springing?
 *
 *  Two ways it isn't: reduced motion, or a starting box already most of the
 *  destination — where the "growth" would be a twitch, and doing nothing is
 *  better than performing a movement too small to read as one. */
export function shouldSwap(
  from: SwapRect | null,
  host: SwapRect | null,
  reducedMotion: boolean,
): boolean {
  if (reducedMotion || !from || !host) return false;
  if (host.width <= 0 || host.height <= 0) return false;
  return (from.width * from.height) / (host.width * host.height) < 0.7;
}

/** The incoming surface: from the island's box to its own, overshooting a
 *  little on the way.
 *
 *  Opacity resolves early and independently of the shape. A surface that is
 *  still fading while it is still growing reads as materializing out of
 *  nothing; the island was a solid object, and so is this. */
export function springInKeyframes(
  from: SwapRect,
  host: SwapRect,
): Keyframe[] {
  return [
    {
      transform: inverseTransform(from, host),
      opacity: 0.35,
      borderRadius: "18px",
      offset: 0,
    },
    { opacity: 1, borderRadius: "24px", offset: 0.35 },
    { transform: "none", opacity: 1, borderRadius: "14px", offset: 1 },
  ];
}

/** The outgoing door: back and away, gone well before the spring lands.
 *
 *  It must NOT simply vanish on frame one — that whole-screen disappearance is
 *  the "janky navigation" every previous attempt left behind. It also must not
 *  linger, or the two surfaces are legible on top of each other. */
export function fadeOutKeyframes(): Keyframe[] {
  return [
    { opacity: 1, transform: "scale(1)", offset: 0 },
    { opacity: 0, transform: "scale(0.97)", offset: 1 },
  ];
}

/** How long the door stays mounted. A fraction of the swap: it is out of sight
 *  by then, and keeping a whole surface alive behind another one costs real
 *  work on every frame of the spring. */
export const FADE_OUT_MS = Math.round(SWAP_MS * 0.55);

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
