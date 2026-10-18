// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The stage steps back while a menu is open over it (board 4d): the session
//! stage fades to 55% so the menu reads as the thing in front, and nothing
//! under it moves.
//!
//! A menu says it is open with `useStageDim(open)`; while any one is, this
//! stamps `html[data-rl-stage-dim]`, and topbar.css fades the element the
//! stage marks with `.rl-flow-stage`. Counted, so two menus overlapping (the
//! Tools menu closing as a row menu opens) never clear each other's dim. A
//! no-op in the classic shell, which has no stage to dim.

import { useLayoutEffect } from "react";
import { isFlowShell } from "../lib/shellFlag";

let open = 0;

function stamp(): void {
  const root = document.documentElement;
  if (open > 0) root.dataset.rlStageDim = "";
  else delete root.dataset.rlStageDim;
}

/** Hold the stage dim while `active`. Layout effect, so the dim lands in the
 *  frame the menu paints in rather than one after it. */
export function useStageDim(active: boolean): void {
  useLayoutEffect(() => {
    if (!active || !isFlowShell()) return;
    open += 1;
    stamp();
    return () => {
      open = Math.max(0, open - 1);
      stamp();
    };
  }, [active]);
}

/** Tests only. */
export function resetStageDimForTests(): void {
  open = 0;
  stamp();
}
