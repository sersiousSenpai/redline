// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";

// The hover reveal for immersive chrome: the header/footer collapse to slim
// hull rails, and pointing at a rail slides the real bar back in. Same shape
// as useAutoExitFullscreen — the decision is a pure exported predicate with a
// test, the effect around it stays thin enough to read in one sitting.

export interface EdgeRevealState {
  /** Is the chrome currently shown? */
  revealed: boolean;
  /** The pointer just crossed onto the slim rail (the reveal trigger). */
  overRail: boolean;
  /** The pointer is on the revealed chrome itself. */
  overChrome: boolean;
  /** Open header dropdowns — App already counts these for `browserVisible`. */
  menusOpen: number;
}

/** Should the chrome be shown? Pointing at the rail reveals; leaving the
 *  revealed chrome retracts — EXCEPT while a menu is open. A settings menu
 *  hangs below the header, so the pointer travelling into it has already left
 *  the header; retracting there would tear the menu out from under the
 *  pointer mid-click. */
export function shouldReveal(s: EdgeRevealState): boolean {
  if (s.overRail) return true;
  if (!s.revealed) return false;
  if (s.menusOpen > 0) return true;
  return s.overChrome;
}

export interface EdgeReveal {
  revealed: boolean;
  /** Rail `onPointerEnter`. */
  onRailEnter: () => void;
  /** Revealed-chrome `onPointerEnter` / `onPointerLeave`. */
  onChromeEnter: () => void;
  onChromeLeave: () => void;
}

/** ~250ms of slack on the way out, so the pointer can cross the seam between
 *  the bar and something it is reaching for without the bar snapping shut. */
const GRACE_MS = 250;

export function useEdgeReveal(opts: {
  /** Immersive is on for this surface — otherwise the chrome is simply there
   *  and this hook is inert. */
  enabled: boolean;
  menusOpen: number;
}): EdgeReveal {
  const { enabled, menusOpen } = opts;
  const [revealed, setRevealed] = useState(false);
  // Pointer state the predicate needs, in refs: none of it should re-render
  // anything on its own, and the grace timer has to read the freshest values.
  const overChrome = useRef(false);
  const revealedRef = useRef(false);
  revealedRef.current = revealed;
  const menusRef = useRef(menusOpen);
  menusRef.current = menusOpen;
  const timer = useRef(0);

  // `overRail` is a momentary trigger rather than a tracked state — the rail
  // unmounts the instant it works, so it can never receive its own leave.
  const settle = useCallback((overRail: boolean) => {
    window.clearTimeout(timer.current);
    setRevealed(
      shouldReveal({
        revealed: revealedRef.current,
        overRail,
        overChrome: overChrome.current,
        menusOpen: menusRef.current,
      }),
    );
  }, []);

  const onRailEnter = useCallback(() => {
    // The bar replaces the rail UNDER the pointer, and a stationary pointer
    // gets no enter event for an element that appears beneath it. So the
    // crossing is recorded as "on the chrome" in the same breath — true by
    // construction, since the rail's box sits inside the bar's. Without this
    // the bar would arrive already scheduled to retract.
    overChrome.current = true;
    settle(true);
  }, [settle]);

  const onChromeEnter = useCallback(() => {
    overChrome.current = true;
    settle(false);
  }, [settle]);

  const onChromeLeave = useCallback(() => {
    overChrome.current = false;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => settle(false), GRACE_MS);
  }, [settle]);

  // Closing the last menu with the pointer already away from the chrome
  // produces no pointer event of its own — this is the retract for that case.
  useEffect(() => {
    if (menusOpen > 0 || !revealed || overChrome.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => settle(false), GRACE_MS);
  }, [menusOpen, revealed, settle]);

  // Leaving immersive (or the manifest opt-out) drops the whole thing back to
  // "not revealed", so the next entry starts from the rail again.
  useEffect(() => {
    if (enabled) return;
    overChrome.current = false;
    window.clearTimeout(timer.current);
    setRevealed(false);
  }, [enabled]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return {
    revealed: enabled && revealed,
    onRailEnter,
    onChromeEnter,
    onChromeLeave,
  };
}
