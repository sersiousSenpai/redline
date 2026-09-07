// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The frontend half of the token/provenance meter: the wire shape
//! `meter.rs` emits, the rev guard that makes an out-of-order event harmless,
//! and the two derived readings every surface renders.
//!
//! `rev` is to the meter what `seq` is to the delta stream, with one
//! simplification: the meter is a SNAPSHOT, not an accumulation. Each event
//! carries the whole meter, so dropping a stale one loses nothing — where a
//! dropped delta would lose text. That is why the guard here is a plain
//! monotone comparison rather than the delta path's append-then-emit dance.

import { contextWindow, modelInfo } from "./modelInfo";

/** One thing a turn was doing while you waited — `meter::Activity`. */
export interface Activity {
  at: number;
  /** `requesting` | `thinking` | `tool` | `rateLimit`. Pick icons and tone
   *  from this, never by matching on the label text. */
  kind: string;
  label: string;
}

/** An outstanding rate limit — `meter::RateLimit`. Only ever present when the
 *  CLI's status was NOT `allowed`; the routine per-turn heartbeat is not a
 *  stall and never reaches here. */
export interface RateLimit {
  status: string;
  /** Unix **seconds**, the CLI's unit — multiply before `new Date()`. */
  resetsAt: number | null;
  kind: string | null;
}

/** What one turn spent and what produced it — `meter::TurnMeter`. */
export interface TurnMeter {
  /** The model that ACTUALLY answered. Not the configured seat override —
   *  this is the only field that reveals a `--fallback-model` swap. */
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  speed: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** High-water context occupancy (input + cache_read + cache_creation, maxed
   *  over messages) — NOT `inputTokens`, which reads `2` on a real turn. */
  contextTokens: number;
  /** The window the CLI stated for this turn; null until its `result` lands. */
  contextWindow: number | null;
  toolCalls: number;
  lastTool: string | null;
  lastToolLabel: string | null;
  thinkingTokens: number | null;
  /** `end_turn` | `max_tokens` | `tool_use` | … `max_tokens` means the reply
   *  was TRUNCATED, which otherwise looks byte-for-byte like a complete one. */
  stopReason: string | null;
  rateLimited: RateLimit | null;
  numTurns: number | null;
  durationMs: number | null;
  /** The CLI's own `total_cost_usd`. Never computed from a price table. */
  costUsd: number | null;
  rev: number;
}

/** The meter event payload every `{surface}-meter` carries, minus the
 *  surface's own id fields. */
export interface MeterPayload {
  rev: number;
  meter: TurnMeter;
  activity: Activity | null;
}

export function emptyMeter(): TurnMeter {
  return {
    model: null,
    effort: null,
    serviceTier: null,
    speed: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextTokens: 0,
    contextWindow: null,
    toolCalls: 0,
    lastTool: null,
    lastToolLabel: null,
    thinkingTokens: null,
    stopReason: null,
    rateLimited: null,
    numTurns: null,
    durationMs: null,
    costUsd: null,
    rev: 0,
  };
}

/**
 * Adopt an incoming meter if it is newer. Returns the CURRENT object
 * unchanged when the incoming one is stale or equal, so React sees no new
 * identity and nothing re-renders.
 */
export function mergeMeter(
  current: TurnMeter | null,
  incoming: TurnMeter | null | undefined,
): TurnMeter | null {
  if (!incoming) return current;
  if (current && incoming.rev <= current.rev) return current;
  // Every window the CLI states is worth remembering: it primes the pressure
  // bar for the NEXT turn on this model, before that turn's own result lands.
  if (incoming.contextWindow) {
    contextWindow(incoming.model, incoming.contextWindow);
  }
  return incoming;
}

/** Total tokens the turn spent — what a rollup adds up. */
export function totalTokens(m: TurnMeter): number {
  return (
    m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens
  );
}

/** Share of the input that was served from cache. Null when there was no
 *  input to speak of (a cancelled turn before the first request). */
export function cachedShare(m: TurnMeter): number | null {
  const read = m.cacheReadTokens;
  const total = m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens;
  if (total <= 0) return null;
  return read / total;
}

export interface ContextPressure {
  used: number;
  limit: number;
  /** 0..1, clamped — a window can be exceeded transiently before compaction. */
  fraction: number;
  /** Past this the tint escalates to `--color-warning`. */
  high: boolean;
}

/** How full the context is, or `null` when no limit is known for this model.
 *  A null renders as tokens with NO percentage — never as a guess. */
export function contextPressure(m: TurnMeter | null): ContextPressure | null {
  if (!m || m.contextTokens <= 0) return null;
  const limit = contextWindow(m.model, m.contextWindow);
  if (!limit) return null;
  const fraction = Math.min(1, m.contextTokens / limit);
  return { used: m.contextTokens, limit, fraction, high: fraction >= 0.75 };
}

/**
 * The turn's cost, as the CLI itself reported it.
 *
 * Deliberately NOT computed from a price table: `db.rs` legislates tokens
 * only ("prices move; recorded facts don't"), and the terminal `result` line
 * already carries `total_cost_usd`. Null while a turn streams, and null for a
 * harness that reports none — in both cases the surface shows tokens, which
 * are the honest primary number anyway.
 */
export function turnCostUsd(m: TurnMeter | null): number | null {
  if (!m || m.costUsd == null || !Number.isFinite(m.costUsd)) return null;
  return m.costUsd;
}

/** A drop this steep, relative to the previous turn's occupancy, is a context
 *  RESET rather than a smaller prompt. */
const RESET_FRACTION = 0.4;
/** …and it has to be big in absolute terms too, or a short early thread trips
 *  it on noise. */
const RESET_FLOOR_TOKENS = 5_000;

/**
 * Rows whose context occupancy fell off a cliff from the turn before them.
 *
 * A pressure drop is not a bug — but an unlabeled fall from 78% to 12% reads
 * as a broken meter, and the user stops trusting every other number on the
 * strip with it. Auto-compaction and CLI-session rotation both do this, and
 * from tokens alone the two are indistinguishable — so the marker names the
 * fact ("the context restarted here") rather than guessing the cause.
 *
 * Pure and order-dependent: pass the thread's message ids in render order.
 */
export function contextResets(
  orderedIds: readonly string[],
  meters: Record<string, TurnMeter>,
): Set<string> {
  const out = new Set<string>();
  let prev: TurnMeter | null = null;
  for (const id of orderedIds) {
    const m = meters[id];
    if (!m || m.contextTokens <= 0) continue;
    if (prev) {
      const drop = prev.contextTokens - m.contextTokens;
      if (
        drop >= RESET_FLOOR_TOKENS &&
        drop >= prev.contextTokens * RESET_FRACTION
      ) {
        out.add(id);
      }
    }
    prev = m;
  }
  return out;
}

/** Whether the reply was cut off. A truncated reply currently looks
 *  byte-for-byte like a complete one — this is the only signal. */
export function wasTruncated(m: TurnMeter | null): boolean {
  return m?.stopReason === "max_tokens";
}

/** Compact token count: 950 → "950", 12400 → "12.4k", 2000000 → "2M".
 *
 *  Lifted here from `AgentSeats.tsx`, which held one of two byte-identical
 *  copies (the other was inline in the orchestration surface). */
export function formatTokens(n: number): string {
  const fmt = (v: number, suffix: string) =>
    `${v.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (n >= 1_000_000) return fmt(n / 1_000_000, "M");
  if (n >= 1_000) return fmt(n / 1_000, "k");
  return String(n);
}

/** "1.2s" / "12.4s" / "3m 05s" — turn duration, for the footer. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1).replace(/\.0$/, "")}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** The badge's left half: `Claude · opus · xhigh`, from the OBSERVED model.
 *  Matches `backendChoice.choiceLabel`'s shape so the badge and the Front
 *  Door's picker chip read the same way. */
export function meterBadgeLabel(m: TurnMeter | null): string | null {
  const info = modelInfo(m?.model);
  if (!info) return null;
  const harness =
    info.family === "gpt" ? "Codex" : info.family === "claude" ? "Claude" : null;
  const parts = [harness, info.short, m?.effort ?? null].filter(
    (p): p is string => !!p,
  );
  return parts.join(" · ");
}

/** The footer line under a settled bubble:
 *  `opus · xhigh · 34.2k in (91% cached) · 1.4k out · 12.4s`. */
export function meterFooterLabel(m: TurnMeter | null): string | null {
  if (!m) return null;
  const parts: string[] = [];
  const info = modelInfo(m.model);
  if (info) parts.push(info.short);
  if (m.effort) parts.push(m.effort);
  const inTokens = m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens;
  if (inTokens > 0) {
    const cached = cachedShare(m);
    const pct = cached == null ? null : `${Math.round(cached * 100)}% cached`;
    parts.push(
      pct ? `${formatTokens(inTokens)} in (${pct})` : `${formatTokens(inTokens)} in`,
    );
  }
  if (m.outputTokens > 0) parts.push(`${formatTokens(m.outputTokens)} out`);
  const dur = formatDuration(m.durationMs);
  if (dur) parts.push(dur);
  return parts.length ? parts.join(" · ") : null;
}

/** The activity line's text while a turn is in flight — the newest entry, or
 *  the meter's own standing state when no entry has landed yet. */
export function activityLabel(
  activity: readonly Activity[] | null | undefined,
  m: TurnMeter | null,
): string | null {
  if (m?.rateLimited) {
    const window = m.rateLimited.kind ?? "usage";
    return `Rate limited (${window}) · waiting`;
  }
  const last = activity?.[activity.length - 1];
  if (last) return last.label;
  if (m?.lastToolLabel) return m.lastToolLabel;
  if (m?.thinkingTokens) return "Thinking…";
  return null;
}
