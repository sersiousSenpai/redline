// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Activity, TurnMeter } from "../turnMeter";
export interface NodeStream { streaming: boolean; partial: string; seq: number; attempt: number; meter: TurnMeter | null; activity: Activity[] | null }
export type RunStreamEvent =
  | { kind: "delta"; runId: string; nodeId: string; attempt: number; text: string; seq: number }
  | { kind: "meter"; runId: string; nodeId: string; attempt: number; rev: number; meter: TurnMeter; activity?: Activity[] | null };
export function appendStream(current: NodeStream, event: RunStreamEvent): NodeStream {
  if (event.attempt !== current.attempt) return current;
  if (event.kind === "delta") {
    if (event.seq <= current.seq) return current;
    // Recovery snapshots heal missed chunks; duplicate/late events never
    // append text twice.
    return { ...current, seq: event.seq, partial: (current.partial + event.text).slice(-120_000) };
  }
  if (event.rev <= (current.meter?.rev ?? -1)) return current;
  return { ...current, meter: event.meter, activity: event.activity ?? current.activity };
}
