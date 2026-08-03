// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef } from "react";

import { computePaneLayout, type PaneLayoutInput } from "../lib/paneLayout";

/** The discussion pane's fullscreen overlay (⤢) is an explicit user mode —
 *  unlike the stateless curtain, nothing retracts it when space frees up. So:
 *  when a space-freeing TRANSITION happens (the sessions sidebar collapses,
 *  or the window grows) while the overlay is up, and the pane would now fit
 *  beside a full-width doc, exit fullscreen so the doc reflows into the freed
 *  space. Event-driven on purpose: a user who re-enters ⤢ afterwards keeps it
 *  until the next freeing transition — the rule never fights them. */
export function shouldExitFullscreen(
  prev: { sidebarCollapsed: boolean; winWidth: number },
  next: PaneLayoutInput,
  paneFullscreen: boolean,
): boolean {
  if (!paneFullscreen) return false;
  const sidebarJustCollapsed = !prev.sidebarCollapsed && next.sidebarCollapsed;
  const windowGrew = next.winWidth > prev.winWidth;
  if (!sidebarJustCollapsed && !windowGrew) return false;
  // Exit only when the hypothetical side-by-side layout is curtain-free —
  // the same space model the curtain itself uses.
  return !computePaneLayout({ ...next, paneFullscreen: false }).curtainActive;
}

export function useAutoExitFullscreen(opts: {
  paneFullscreen: boolean;
  setPaneFullscreen: (v: boolean) => void;
  layoutInput: PaneLayoutInput;
}) {
  const { paneFullscreen, setPaneFullscreen, layoutInput } = opts;
  const prevRef = useRef({
    sidebarCollapsed: layoutInput.sidebarCollapsed,
    winWidth: layoutInput.winWidth,
  });
  const { sidebarCollapsed, winWidth } = layoutInput;
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { sidebarCollapsed, winWidth };
    if (shouldExitFullscreen(prev, layoutInput, paneFullscreen)) {
      setPaneFullscreen(false);
    }
    // Trigger only on the two freeing signals; the transition check above
    // makes any extra run a no-op, so the sparse dep list is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarCollapsed, winWidth]);
}
