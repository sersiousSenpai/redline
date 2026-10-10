// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What a live reply's tail row says (`ReplyBlock`): one plain phrase for
//! what the turn is doing, how long it has been going, and how long since it
//! last showed a sign of life. Only public activity metadata reaches it, never
//! model reasoning text.

import type { Activity, TurnMeter } from "./turnMeter";

/** A surface's own words for the turn's current step (the chat room's and
 *  Memory's retrieval narration), stamped when they arrived. `running`: the
 *  surface knows the step is still going (the page chat tracks it against
 *  the text itself), so text written before it never reads as "Writing the
 *  reply". */
export interface ChatProgressStatus { label: string; at: number; running?: boolean }

function plainActivity(label: string): string {
  return ({ "Read…": "Reading files", "Grep…": "Searching source files", "Glob…": "Finding files", "Bash…": "Running a tool", "Requesting…": "Waiting for the model" } as Record<string, string>)[label] ?? label;
}

export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The phrase, the elapsed clock and the quiet time, `now` against the
 *  turn's `startedAt`. Text arriving since the last event reads "Writing the
 *  reply"; a status from before this turn started is ignored. */
export function chatProgress(
  activity: readonly Activity[], meter: TurnMeter | null,
  status: ChatProgressStatus | null, startedAt: number, now: number, lastOutputAt = 0,
) {
  const latest = activity[activity.length - 1];
  const recentStatus = status && status.at >= startedAt && (!latest || status.at >= latest.at) ? status : null;
  const lastEventAt = Math.max(latest?.at ?? 0, recentStatus?.at ?? 0);
  const label = meter?.rateLimited ? "Rate limited — waiting for the provider"
    : lastOutputAt > lastEventAt && !recentStatus?.running ? "Writing the reply"
    : plainActivity(recentStatus?.label ?? latest?.label ?? "Preparing your reply");
  const lastAt = Math.max(startedAt, lastEventAt, lastOutputAt);
  return { label, elapsed: elapsedLabel(now - startedAt), quietFor: now - lastAt };
}
