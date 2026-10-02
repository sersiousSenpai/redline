// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { DocumentPlateMode } from "./documentPlate";
import type { MainSurface } from "./mainSurface";

/** What a plan arriving from a session does to the reader.
 *
 *  - `focus`: select it. On the document surface that brings it on screen
 *    (from the Front Door the plate turns into the plan); on a masked surface
 *    (browser, memory, runs) it becomes what you come back to, and the
 *    surface itself is left alone — the caller offers a Review instead.
 *  - `flash`: you are reading ANOTHER plan. Nothing moves: the arrival marks
 *    its sidebar row and says so in a brief notice with Open.
 *
 *  One rule replaces the old special cases. "A live dock conversation on
 *  another plan" was only ever a way of reading another plan. */
export type ArrivalFocus = "focus" | "flash";

export interface ArrivalState {
  /** The session on screen, or null. */
  activeId: string | null;
  /** The session the plan belongs to. */
  sessionId: string;
  mainSurface: MainSurface;
  plateMode: DocumentPlateMode;
}

export function arrivalFocus(state: ArrivalState): ArrivalFocus {
  const readingAnotherPlan =
    state.activeId !== null &&
    state.activeId !== state.sessionId &&
    state.mainSurface === "document" &&
    state.plateMode === "plan";
  return readingAnotherPlan ? "flash" : "focus";
}

/** The arrival notice's copy. "Intercepted" described the mechanism, not the
 *  news — the news is that a plan is here. */
export function arrivalMessage(title: string | null | undefined): string {
  const t = title?.trim();
  return t ? `New plan · ${t}` : "New plan";
}
