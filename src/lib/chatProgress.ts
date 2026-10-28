// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What a live reply's tail row says (`ReplyBlock`): the step the turn is
//! running, how long it has been going, and how long since it last showed a
//! sign of life. Only public activity metadata reaches it, never model
//! reasoning text.
//!
//! Waiting is not news (D28). Before the first token, between tokens and
//! while the text streams, the row is the quiet typing state — the shared
//! Spinner and no words (`label: null`): no "Preparing your reply", no
//! "Waiting for the model", no "Writing the reply", no "Still waiting".
//! The rate-limit warning the CLI sends while a request still goes through
//! is not news either; a limit that actually fails the turn says so once,
//! as the turn's inline error row. A step that is work — a file read, a
//! search, a page — keeps its plain name.

import type { Activity, TurnMeter } from "./turnMeter";

/** A surface's own words for the turn's current step (the chat room's and
 *  Memory's retrieval narration), stamped when they arrived. `running`: the
 *  surface knows the step is still going (the page chat tracks it against
 *  the text itself), so text written before it never hides it. */
export interface ChatProgressStatus { label: string; at: number; running?: boolean }

/** The words for a step, or null for a step that is only waiting. */
function plainActivity(label: string): string | null {
  const words = ({ "Read…": "Reading files", "Grep…": "Searching source files", "Glob…": "Finding files", "Bash…": "Running a tool", "Requesting…": null } as Record<string, string | null>)[label];
  return words === undefined ? label : words;
}

/** Activity that is only the wait (a rate-limit notice the CLI sent while
 *  the request goes through, a request starting): never the row's words. */
const WAITING_KINDS = new Set(["rateLimit", "requesting"]);

/** The daemon's own words for a turn that has not started streaming — the
 *  context being gathered, the model starting, the request out. Only the
 *  wait, said in words: an older daemon still sends them as a status, and
 *  they never reach the row (the shared Spinner says it, aria "Replying"). */
const WAITING_WORDS = new Set(["preparing chat context", "starting the selected model", "waiting for the model", "preparing your reply"]);

/** A status that only names the wait, never a step of work. */
export function isWaitingStatus(label: string | null | undefined): boolean {
  return WAITING_WORDS.has((label ?? "").trim().toLowerCase());
}

export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The step's words (null: the quiet typing state), the elapsed clock and
 *  the quiet time, `now` against the turn's `startedAt`. Text arriving since
 *  the last step is the reply being written, which is the typing state; a
 *  status from before this turn started is ignored. The meter is read for
 *  nothing here any more: a rate limit in flight is the wait. */
export function chatProgress(
  activity: readonly Activity[], _meter: TurnMeter | null,
  status: ChatProgressStatus | null, startedAt: number, now: number, lastOutputAt = 0,
): { label: string | null; elapsed: string; quietFor: number } {
  const steps = activity.filter((entry) => !WAITING_KINDS.has(entry.kind));
  const latest = steps[steps.length - 1];
  const recentStatus = status && !isWaitingStatus(status.label) && status.at >= startedAt && (!latest || status.at >= latest.at) ? status : null;
  const lastEventAt = Math.max(latest?.at ?? 0, recentStatus?.at ?? 0);
  const writing = lastOutputAt > lastEventAt && !recentStatus?.running;
  const label = writing ? null : plainActivity(recentStatus?.label ?? latest?.label ?? "") || null;
  const lastAt = Math.max(startedAt, lastEventAt, lastOutputAt, activity[activity.length - 1]?.at ?? 0);
  return { label, elapsed: elapsedLabel(now - startedAt), quietFor: now - lastAt };
}
