// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useLayoutEffect, useRef } from "react";

import { rafCoalesce } from "../lib/raf";
import {
  nextCollapsed,
  nextStage,
  type ClearanceStage,
} from "../lib/textClearance";

/** Keep a control floating in the document's margin out of the text's way.
 *
 *  Writes one `data-*` attribute on the control; the yielding itself is CSS
 *  keyed on that attribute. Two forms:
 *
 *  - default: a two-state toggle between "1" and "0" (`nextCollapsed`);
 *  - with `stages`: a three-stage ladder writing the stage NAME
 *    ("full" | "stowed" | "icon") into the same attribute (`nextStage`).
 *
 *  Deliberately an attribute rather than React state: this runs on every frame
 *  of a pane drag, and a state flip here would re-render the whole document
 *  column. */
export function useTextClearance({
  ctrlRef,
  textRef,
  textInset,
  flag,
  stages,
  onMeasure,
  deps = [],
}: {
  ctrlRef: React.RefObject<HTMLElement | null>;
  /** The text column to stay clear of. Omit and nothing happens. */
  textRef?: React.RefObject<HTMLElement | null>;
  /** That column's left padding, px — where its text starts, as opposed to
   *  where its box does. Pass 0 to clear the column's box itself (the drafter
   *  measures against the page SHEET — in a Word-style surface the sheet is
   *  the document). */
  textInset: number;
  /** dataset key to toggle, e.g. "rlStowed". */
  flag: string;
  /** Opt into the stage ladder: given the control's EXPANDED width/height,
   *  return each stage's right edge in px from the OFFSET PARENT's left edge.
   *  Computed from the control's own styling constants — never from live
   *  layout of a collapsed pose, which would feed the collapse back in. */
  stages?: (
    expandedW: number,
    expandedH: number,
  ) => Record<ClearanceStage, number>;
  /** Called with the control's EXPANDED metrics whenever they're re-measured,
   *  for controls whose collapsed pose depends on its own size. Never fires
   *  mid-collapse, so a pose can't shift under its own animation. */
  onMeasure?: (el: HTMLElement, width: number, height: number) => void;
  /** Extra deps for hosts that mount the control conditionally — without them
   *  the observer never attaches to a control that appeared after mount. */
  deps?: React.DependencyList;
}): void {
  // The expanded metrics, cached. A control that sheds content when it
  // collapses (the Contents button drops its label; the pill's icon pose drops
  // "Discuss") measures narrower once collapsed, and feeding THAT back in
  // would immediately say "there's room now" and expand it — a permanent
  // flip-flop. Refreshed only while expanded, so the question stays "would the
  // full-size control overlap?" in every state.
  const expandedW = useRef(0);
  const expandedH = useRef(0);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const stagesRef = useRef(stages);
  stagesRef.current = stages;

  // Layout effect, not passive: the first pass has to land before paint. A
  // passive one would show the expanded control for a frame and then collapse
  // it — and because a transition never runs on the first style resolution but
  // does run on every later one, that one frame is the difference between
  // mounting already-collapsed and visibly snapping shut on arrival.
  useLayoutEffect(() => {
    const ctrl = ctrlRef.current;
    const text = textRef?.current ?? null;
    // Observe the SCROLLER, not the control's offset parent. The TOC rail docks
    // by animating the scroller's padding-left, which slides the text column
    // sideways without resizing the pane — an observer on the pane would sleep
    // through it. The scroller's content box does shrink, so it catches both.
    const container = text?.parentElement ?? null;
    if (!ctrl || !text || !container) return;

    const recompute = () => {
      const parent = ctrl.offsetParent as HTMLElement | null;
      if (!parent) return; // display:none somewhere above — nothing to decide
      const stageFns = stagesRef.current;
      if (stageFns) {
        // Stage-ladder form. The attribute holds the stage name; anything
        // unset/unknown reads as "full" (the mount pose).
        const raw = ctrl.dataset[flag];
        const prev: ClearanceStage =
          raw === "stowed" || raw === "icon" ? raw : "full";
        if (prev === "full") {
          expandedW.current = ctrl.offsetWidth;
          expandedH.current = ctrl.offsetHeight;
          onMeasureRef.current?.(ctrl, ctrl.offsetWidth, ctrl.offsetHeight);
        }
        const w = expandedW.current || ctrl.offsetWidth;
        const h = expandedH.current || ctrl.offsetHeight;
        const parentLeft = parent.getBoundingClientRect().left;
        const rel = stageFns(w, h);
        const next = nextStage(prev, text.getBoundingClientRect().left + textInset, {
          full: parentLeft + rel.full,
          stowed: parentLeft + rel.stowed,
          icon: parentLeft + rel.icon,
        });
        if (ctrl.dataset[flag] !== next) ctrl.dataset[flag] = next;
        return;
      }
      const on = ctrl.dataset[flag] === "1";
      if (!on) {
        expandedW.current = ctrl.offsetWidth;
        onMeasureRef.current?.(ctrl, ctrl.offsetWidth, ctrl.offsetHeight);
      }
      // offsetLeft/offsetWidth, NOT getBoundingClientRect: a rect reflects the
      // collapse animation's transform, and the Discuss pill's hinge sweeps its
      // rect ~31px left of where it rests. Reading that mid-swing overshoots
      // the hysteresis band and bounces the control back — layout coordinates
      // are the only ones the animation can't move.
      const ctrlRight =
        parent.getBoundingClientRect().left +
        ctrl.offsetLeft +
        (expandedW.current || ctrl.offsetWidth);
      const textLeft = text.getBoundingClientRect().left + textInset;
      const next = nextCollapsed(on, ctrlRight, textLeft) ? "1" : "0";
      // Idempotent write — an unchanged attribute must not dirty style.
      if (ctrl.dataset[flag] !== next) ctrl.dataset[flag] = next;
    };
    recompute();

    // Deliberately NOT gated on isResizing(), unlike the doc-zoom control's
    // twin computation: that one ends in a React render, this one ends in a
    // single dataset write. Two rects a frame is worth it, because "the pane is
    // being resized" is exactly the moment this needs to be right — bailing
    // would park the control on top of the text for the whole drag and only
    // jump it clear on release.
    const onGeometry = rafCoalesce(recompute);
    const ro = new ResizeObserver(onGeometry);
    ro.observe(container);
    ro.observe(ctrl); // the label's width moves with the user's font choice
    return () => {
      ro.disconnect();
      onGeometry.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrlRef, textRef, textInset, flag, ...deps]);
}
