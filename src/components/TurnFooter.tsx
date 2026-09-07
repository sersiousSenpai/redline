// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The quiet line under a settled assistant bubble:
//!
//! ```
//! opus · xhigh · 34.2k in (91% cached) · 1.4k out · 12.4s      truncated
//! ```
//!
//! Two things it says that nothing else in the app could:
//!
//! - **Which model actually answered.** The only model chip on any chat
//!   surface today shows the *configured* seat override. When
//!   `--fallback-model` kicks in, nothing says so — until this.
//! - **That the reply was cut off.** `stop_reason: max_tokens` means the model
//!   ran out of room mid-sentence, and a truncated reply currently looks
//!   byte-for-byte like a complete one. That is the quietest way this system
//!   can mislead, so the marker is `--color-warning` and not optional.
//!
//! Cost is the CLI's own `total_cost_usd`, off by default: Claude Code on a
//! subscription is not billed per token, so a confident `$0.42` would be a lie
//! for most users. Tokens are the honest primary number — which is exactly
//! what `db.rs`'s schema law already legislates.

import {
  formatTokens,
  meterFooterLabel,
  turnCostUsd,
  wasTruncated,
  type TurnMeter,
} from "../lib/turnMeter";

/** Settings key for the list-price estimate. Off unless explicitly turned on. */
export const SHOW_COST_KEY = "redline.meter.showCost";

export function costEnabled(): boolean {
  try {
    return localStorage.getItem(SHOW_COST_KEY) === "true";
  } catch {
    return false;
  }
}

export default function TurnFooter({
  meter,
  showCost,
  contextReset,
}: {
  meter: TurnMeter | null | undefined;
  /** Override the stored setting (the settings preview passes it directly). */
  showCost?: boolean;
  /** This turn's context occupancy fell off a cliff from the one before it
   *  (`contextResets`). Labelled rather than left to look like a broken
   *  meter. */
  contextReset?: boolean;
}) {
  if (!meter) return null;
  const line = meterFooterLabel(meter);
  if (!line) return null;
  const cost = (showCost ?? costEnabled()) ? turnCostUsd(meter) : null;
  const truncated = wasTruncated(meter);
  return (
    <div
      className="flex items-center gap-2 flex-wrap"
      style={{
        fontSize: "calc(9.5px * var(--rl-discussion-zoom, 1))",
        lineHeight: 1.4,
        color: "var(--color-ink-muted)",
        fontVariantNumeric: "tabular-nums",
      }}
      title={[
        `input ${meter.inputTokens.toLocaleString()}`,
        `output ${meter.outputTokens.toLocaleString()}`,
        `cache read ${meter.cacheReadTokens.toLocaleString()}`,
        `cache write ${meter.cacheCreationTokens.toLocaleString()}`,
        meter.serviceTier ? `tier ${meter.serviceTier}` : null,
        meter.toolCalls > 0 ? `${meter.toolCalls} tool calls` : null,
        meter.model ?? null,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <span>{line}</span>
      {cost != null && (
        <span title="List-price estimate reported by the CLI — not what a subscription is billed">
          ~${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}
        </span>
      )}
      {contextReset && (
        <span
          title="The context restarted here — auto-compaction, or a fresh CLI session. The drop in occupancy is real, not a broken meter."
          style={{
            borderLeft: "2px solid var(--color-rule)",
            paddingLeft: "6px",
          }}
        >
          context reset
        </span>
      )}
      {truncated && (
        <span
          style={{ color: "var(--color-warning)", fontWeight: 600 }}
          title="The model hit its output limit — this reply is cut off, not finished"
        >
          truncated
        </span>
      )}
    </div>
  );
}

/** One collapsed line above the composer: what the whole thread has spent,
 *  BY SUBPROCESS. A consult spawns a real child `claude`, so "by seat" is the
 *  honest unit of economics here — not "by message". */
export function ThreadMeterStrip({
  meters,
}: {
  meters: Record<string, TurnMeter>;
}) {
  const rows = Object.values(meters);
  if (rows.length === 0) return null;
  const bySeat = new Map<string, { turns: number; tokens: number; out: number }>();
  for (const m of rows) {
    const key = m.model ?? "unknown";
    const cur = bySeat.get(key) ?? { turns: 0, tokens: 0, out: 0 };
    cur.turns += 1;
    cur.tokens +=
      m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens + m.outputTokens;
    cur.out += m.outputTokens;
    bySeat.set(key, cur);
  }
  const parts = [...bySeat.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([model, v]) => `${model.replace(/^claude-/, "")} ${formatTokens(v.tokens)}`);
  const total = rows.reduce(
    (n, m) =>
      n + m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens + m.outputTokens,
    0,
  );
  return (
    <div
      className="flex items-center gap-2 flex-wrap px-1"
      style={{
        fontSize: "9px",
        color: "var(--color-ink-muted)",
        fontVariantNumeric: "tabular-nums",
      }}
      title={`${rows.length} settled turns on this thread`}
    >
      <span style={{ fontWeight: 600 }}>{formatTokens(total)} tok</span>
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  );
}
