// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What a model id means, for display and for the context-pressure readout.
//!
//! The load-bearing decision here is what this module REFUSES to know. There
//! is no static price table and no static context-window table beyond one
//! rule, because both would be guesses that go stale silently — and a wrong
//! context limit is the single failure mode that would make the whole meter
//! untrustworthy on exactly the sessions where pressure matters most.
//!
//! Instead:
//!
//! - **The window comes from the CLI.** A finished turn's `result` line
//!   carries `modelUsage[model].contextWindow` as fact (Experiment (j)), which
//!   `meter.contextWindow` records. `rememberWindow` caches what was observed
//!   per model id, so from the second turn onward the bar is live from the
//!   first token. Until something has been observed, an unknown model shows
//!   tokens and **no percentage** — never a guessed one.
//! - **The `[1m]` suffix is the one exception**, because it is a statement in
//!   the id itself rather than a fact about a product: `claude-opus-5[1m]` has
//!   a 1M window. Reading it as 200k would make the meter read ~5× too high.
//! - **Cost is the CLI's own `total_cost_usd`**, carried on the same `result`
//!   line — so there is no list-price table to drift.

/** A remembered window, keyed by the exact model id. */
const WINDOW_KEY = "redline.modelInfo.windows";

/** A 1M-context id says so in its own name. The only window rule that doesn't
 *  need an observation behind it. */
const ONE_M_SUFFIX = /\[1m\]$/i;

export interface ModelInfo {
  /** The id exactly as observed. */
  id: string;
  /** Compact chip text: `claude-haiku-4-5-20251001` → `haiku-4-5`. */
  short: string;
  /** `claude` | `gpt` | `unknown` — what harness produced it. */
  family: "claude" | "gpt" | "unknown";
  /** True when the id itself declares a 1M window. */
  extendedContext: boolean;
}

/** Compact model chip text: the stored id minus the family prefix and any
 *  trailing date stamp — "claude-haiku-4-5-20251001" reads "haiku-4-5". The
 *  full id stays in the title attribute. Lifted from `MemoryInspector`, which
 *  had the only copy. */
export function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/^gpt-/i, "GPT-")
    .replace(/-20\d{6}(\[1m\])?$/i, "$1");
}

export function modelInfo(model: string | null | undefined): ModelInfo | null {
  const id = (model ?? "").trim();
  if (!id) return null;
  const lower = id.toLowerCase();
  const family = lower.startsWith("claude")
    ? "claude"
    : lower.startsWith("gpt") || lower.includes("codex")
      ? "gpt"
      : "unknown";
  return {
    id,
    short: shortModel(id),
    family,
    extendedContext: ONE_M_SUFFIX.test(id),
  };
}

// --- context window --------------------------------------------------------

type WindowMap = Record<string, number>;

function loadWindows(): WindowMap {
  try {
    const raw = localStorage.getItem(WINDOW_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: WindowMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    // A hostile/absent localStorage is a degraded readout, never a crash.
    return {};
  }
}

/** Record a window the CLI stated, so the next turn's live bar has a limit
 *  before its own `result` line lands. Observed, not assumed — which is the
 *  whole difference between this and a hardcoded table. */
export function rememberWindow(model: string | null | undefined, window: number): void {
  const id = (model ?? "").trim();
  if (!id || !Number.isFinite(window) || window <= 0) return;
  const map = loadWindows();
  if (map[id] === window) return;
  map[id] = window;
  try {
    localStorage.setItem(WINDOW_KEY, JSON.stringify(map));
  } catch {
    // Full/blocked storage just means no priming next time.
  }
}

/**
 * The model's context window, or `null` when nothing justifies a number.
 *
 * Order of authority: what the CLI said on THIS turn, then the `[1m]` marker
 * in the id, then what the CLI said on a previous turn with this id. A `null`
 * is an instruction to render tokens without a percentage — not a cue to pick
 * a default.
 */
export function contextWindow(
  model: string | null | undefined,
  observed?: number | null,
): number | null {
  if (observed != null && Number.isFinite(observed) && observed > 0) {
    rememberWindow(model, observed);
    return observed;
  }
  const info = modelInfo(model);
  if (!info) return null;
  if (info.extendedContext) return 1_000_000;
  const remembered = loadWindows()[info.id];
  return remembered && remembered > 0 ? remembered : null;
}

/** Test seam: forget every observed window. */
export function resetWindows(): void {
  try {
    localStorage.removeItem(WINDOW_KEY);
  } catch {
    /* nothing to forget */
  }
}
