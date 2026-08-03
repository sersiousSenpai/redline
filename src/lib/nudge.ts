// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Memory-driven workspace nudges — the felt layer's subtlety. The app should
// appear to have *noticed* a habit, not to be running a tour: at most ONE
// quiet suggestion at a time, and each suggestion can only ever fire once —
// accepting edits ~/.redline/workspace.json, dismissing retires the
// suggestion id permanently.
//
// v1 signal (a deliberate deviation from the plan's Keeper-Observations
// wiring): keeper Observations cite patterns in the prompt lake, not in
// surface behavior, so the landing nudge derives from behavior the app can
// actually witness — the first surface you switch to shortly after each
// launch. If nearly every launch starts with the same switch, the app offers
// to just land there. The state is a tiny app_settings JSON blob; the logic
// here is pure so it tests without a backend.

import type { MainSurface } from "./mainSurface";
import type { Workspace } from "../config/workspace";
import {
  currentLanding,
  surfaceEnabled,
  MAIN_SURFACE_DESCRIPTORS,
  type ToggleableSurface,
} from "../config/workspace";

export interface NudgeState {
  /** First surface switched to within the watch window after each launch,
   *  oldest first, capped at NUDGE_HISTORY. */
  launches: string[];
  /** Suggestion ids the user dismissed — retired forever. */
  dismissed: string[];
}

/** A switch later than this after boot is a work move, not a landing habit. */
export const NUDGE_WINDOW_MS = 90_000;
export const NUDGE_HISTORY = 5;
/** How many of the recent launches must agree before the app speaks up. */
export const NUDGE_THRESHOLD = 4;

export function emptyNudgeState(): NudgeState {
  return { launches: [], dismissed: [] };
}

export function parseNudgeState(text: string | null | undefined): NudgeState {
  if (!text) return emptyNudgeState();
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return emptyNudgeState();
    const obj = raw as Record<string, unknown>;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return {
      launches: strings(obj.launches).slice(-NUDGE_HISTORY),
      dismissed: strings(obj.dismissed),
    };
  } catch {
    return emptyNudgeState();
  }
}

export function serializeNudgeState(state: NudgeState): string {
  return JSON.stringify(state);
}

/** Record this launch's first post-boot surface switch. */
export function recordLaunch(state: NudgeState, surface: MainSurface): NudgeState {
  return {
    ...state,
    launches: [...state.launches, surface].slice(-NUDGE_HISTORY),
  };
}

export function dismissSuggestion(state: NudgeState, id: string): NudgeState {
  if (state.dismissed.includes(id)) return state;
  return { ...state, dismissed: [...state.dismissed, id] };
}

export interface LandingSuggestion {
  /** Stable identity — `landing:<surface>` — so a dismissal retires it. */
  id: string;
  surface: MainSurface;
  message: string;
}

/** The one landing suggestion the recent history supports, or null. Only
 *  offered while the landing is still "last" (an explicit landing choice —
 *  by accept or by hand-editing the manifest — silences this family), only
 *  for an enabled surface, and never twice for the same surface. */
export function suggestLanding(
  state: NudgeState,
  ws: Workspace,
): LandingSuggestion | null {
  if (currentLanding(ws) !== "last") return null;
  const recent = state.launches.slice(-NUDGE_HISTORY);
  if (recent.length < NUDGE_THRESHOLD) return null;
  const counts = new Map<string, number>();
  for (const s of recent) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const [surface, count] of counts) {
    if (count < NUDGE_THRESHOLD) continue;
    const desc = MAIN_SURFACE_DESCRIPTORS.find((d) => d.id === surface);
    if (!desc) continue;
    if (
      desc.id !== "document" &&
      !surfaceEnabled(ws, desc.id as ToggleableSurface)
    ) {
      continue;
    }
    const id = `landing:${desc.id}`;
    if (state.dismissed.includes(id)) continue;
    return {
      id,
      surface: desc.id,
      message: `You head to the ${desc.label} after every launch — make it your landing surface?`,
    };
  }
  return null;
}
