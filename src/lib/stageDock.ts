// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow shell's terminal view (deviation 6): ⌘J shows the session's own
//! PTY at full stage. The PTY belongs to the terminal dock, and the dock may
//! never unmount or move to another parent — either one recreates xterm and
//! replays its PTY, or kills it — so the stage cannot hold the terminal. The
//! dock comes to the stage instead: it stays exactly where it is in the tree,
//! goes absolutely positioned (`.rl-term-dock--stage`), and this pins its box
//! to the stage's box, following every resize of either.
//!
//! Insets, not a height: `applyLiveLayout` owns the dock's inline height, and
//! the stage class overrides that one property, so the two never write the
//! same thing.

import { useLayoutEffect, type RefObject } from "react";

interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** The insets that put an absolutely positioned child of `host` over
 *  `stage`, both measured in the viewport. */
export function stageInsets(host: Box, stage: Box): Box {
  return {
    top: stage.top - host.top,
    left: stage.left - host.left,
    right: host.right - stage.right,
    bottom: host.bottom - stage.bottom,
  };
}

const SIDES = ["top", "left", "right", "bottom"] as const;

/** While `active`, keep `dock` over `stage`. */
export function useStageDock(
  dock: RefObject<HTMLElement | null>,
  stage: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useLayoutEffect(() => {
    const el = dock.current;
    const target = stage.current;
    if (!active || !el || !target) return;
    // The positioned ancestor the insets are measured against: `<main>`.
    const host = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
    if (!host) return;
    const place = () => {
      const at = stageInsets(host.getBoundingClientRect(), target.getBoundingClientRect());
      for (const side of SIDES) el.style[side] = `${Math.round(at[side])}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(target);
    ro.observe(host);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      for (const side of SIDES) el.style[side] = "";
    };
  }, [active, dock, stage]);
}
