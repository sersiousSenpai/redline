// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// One voice turn, from send to its end, as a pure reducer.
//
// The backend numbers every turn — `generation` names the warm child, `turn`
// which of its turns — and stamps both on every `voice-*` event. That is what
// lets the panel tell the reply it is waiting on from the tail of one it has
// given up on, or from a child that was replaced: an event either names the
// live turn or it is ignored. A 1.5 s "swallow whatever arrives" window used to
// do this job, racily, and also swallowed real errors.

import type { Activity } from "../lib/turnMeter";

export interface TurnId {
  generation: number;
  turn: number;
}

/** `sending`: `voice_send` is on its way and has not yet said which turn it
 *  started. `thinking`: started, no text yet. `streaming`: text arriving. */
export type TurnPhase = "idle" | "sending" | "thinking" | "streaming";

export interface TurnState {
  phase: TurnPhase;
  /** The turn being waited on, once known. */
  live: TurnId | null;
  /** The newest turn known to be over; nothing at or before it is news. */
  settled: TurnId | null;
  /** A stop was asked for; the turn's end is on its way. */
  interrupting: boolean;
  /** When the turn was sent — the thinking captions' clock. */
  since: number | null;
  /** What the agent is doing, from `voice-meter`, before it says anything. */
  activity: Activity | null;
}

export const IDLE_TURN: TurnState = {
  phase: "idle",
  live: null,
  settled: null,
  interrupting: false,
  since: null,
  activity: null,
};

export type TurnAction =
  | { type: "send"; at: number }
  | { type: "sent"; id: TurnId }
  | { type: "send-failed" }
  /** A turn already running that this panel did not send (a remount mid-turn,
   *  or a send refused because one was still streaming). */
  | { type: "adopt"; id: TurnId; at: number }
  /** Nothing is running; every turn up to `id` is history. */
  | { type: "baseline"; id: TurnId }
  | { type: "activity"; id: TurnId; activity: Activity | null }
  | { type: "text"; id: TurnId }
  | { type: "interrupt" }
  /** The turn ended: done, interrupted or failed. */
  | { type: "end"; id: TurnId }
  /** The child went away under the turn (`generation` names it), so no end
   *  event is coming. */
  | { type: "lost"; generation?: number };

export const sameTurn = (a: TurnId, b: TurnId) =>
  a.generation === b.generation && a.turn === b.turn;

/** Whether `a` came after `b` (a later child, or a later turn of the same). */
export function newer(a: TurnId, b: TurnId | null): boolean {
  if (!b) return true;
  return a.generation > b.generation || (a.generation === b.generation && a.turn > b.turn);
}

/** Whether an event naming `id` belongs to the turn being waited on. Before
 *  `voice_send` has answered, the first turn newer than the last one that
 *  ended is the one it started. */
export function accepts(s: TurnState, id: TurnId): boolean {
  if (s.live) return sameTurn(s.live, id);
  return s.phase === "sending" && newer(id, s.settled);
}

export function turnReducer(s: TurnState, a: TurnAction): TurnState {
  switch (a.type) {
    case "send":
      return { ...IDLE_TURN, settled: s.settled, phase: "sending", since: a.at };
    case "sent":
      // The turn may already have ended (a fast reply), or been learned from
      // its own first event.
      if (s.phase === "idle" || s.live || !newer(a.id, s.settled)) return s;
      return { ...s, live: a.id, phase: s.phase === "sending" ? "thinking" : s.phase };
    case "send-failed":
      return s.phase === "sending" && !s.live ? { ...IDLE_TURN, settled: s.settled } : s;
    case "adopt":
      if (!newer(a.id, s.settled)) return s;
      return { ...IDLE_TURN, settled: s.settled, phase: "thinking", live: a.id, since: a.at };
    case "baseline":
      return s.phase === "idle" && newer(a.id, s.settled) ? { ...s, settled: a.id } : s;
    case "activity": {
      if (!accepts(s, a.id)) return s;
      const phase = s.phase === "sending" ? "thinking" : s.phase;
      const activity = a.activity ?? s.activity;
      // Most meter events carry no new activity: nothing to re-render.
      if (s.live && phase === s.phase && activity === s.activity) return s;
      return { ...s, live: a.id, phase, activity };
    }
    case "text":
      if (!accepts(s, a.id)) return s;
      if (s.phase === "streaming") return s;
      return { ...s, live: a.id, phase: "streaming" };
    case "interrupt":
      return s.phase === "idle" || s.interrupting ? s : { ...s, interrupting: true };
    case "end":
      return accepts(s, a.id) ? { ...IDLE_TURN, settled: a.id } : s;
    case "lost":
      if (s.phase === "idle") return s;
      if (a.generation !== undefined && s.live && s.live.generation !== a.generation) return s;
      return { ...IDLE_TURN, settled: s.live ?? s.settled };
  }
}

// --- Captions ---------------------------------------------------------------

/** After this long with nothing said, the caption says it is still going. */
export const STILL_AFTER_MS = 12_000;
/** …and after this long, it offers to stop. */
export const OFFER_STOP_AFTER_MS = 45_000;

/** The voice agent's tool labels, in words for someone waiting to hear back.
 *  Its only `Bash` is the local bridge `curl`, which reads the plan; bridge
 *  routes with labels of their own (memory, consults) keep them. */
const TOOL_CAPTIONS: Record<string, string> = {
  "Bash…": "Reading the plan…",
  "Read…": "Reading the code…",
  "Grep…": "Searching the code…",
  "Glob…": "Looking through the files…",
};

/** What the agent is doing before it says anything. */
export function activityCaption(activity: Activity | null): string {
  if (!activity) return "Thinking…";
  switch (activity.kind) {
    case "thinking":
      return "Thinking it through…";
    case "tool": {
      const label = TOOL_CAPTIONS[activity.label] ?? activity.label;
      return label ? label[0].toUpperCase() + label.slice(1) : "Working…";
    }
    case "rateLimit":
      return activity.label;
    default:
      return "Thinking…";
  }
}

/** The thinking line at `elapsedMs` since the turn was sent: the activity,
 *  then "Still …" once the wait is long enough to wonder, then a way out. */
export function thinkingCaption(
  activity: Activity | null,
  elapsedMs: number,
): { text: string; offerStop: boolean } {
  const text = activityCaption(activity);
  if (elapsedMs < STILL_AFTER_MS || activity?.kind === "rateLimit") {
    return { text, offerStop: elapsedMs >= OFFER_STOP_AFTER_MS };
  }
  return {
    text: `Still ${text[0].toLowerCase()}${text.slice(1)}`,
    offerStop: elapsedMs >= OFFER_STOP_AFTER_MS,
  };
}
