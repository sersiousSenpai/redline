// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Pure helpers for the Seat Assignment agent (see `src-tauri/src/seatassign.rs`).
// The agent proposes a whole Agent Seats chart; the user reviews, edits and
// applies it. Everything here is presentation-and-reducer logic kept out of
// AgentSeats.tsx so it can be unit-tested.

/** One seat's stored configuration — mirrors Rust's `seat::SeatConfig`. */
export interface SeatConfig {
  backend?: string;
  model?: string;
  effort?: string;
  fallback?: string;
  binaryPath?: string;
  extraFlags?: string[];
}

/** Mirrors Rust's `seatassign::SeatPick`. */
export interface SeatPick {
  seat: string;
  model?: string;
  effort?: string;
  fallback?: string;
  rationale: string;
  deviates: boolean;
}

/** Mirrors Rust's `seatassign::SeatAssignment`. */
export interface SeatAssignment {
  summary: string;
  picks: SeatPick[];
  /** Present only when the reply carried no usable JSON — the agent's actual
   *  words, so a contract break is diagnosable instead of looking like a
   *  button that does nothing. */
  raw?: string;
}

/** Mirrors Rust's `seatassign::SeatBlurb` — what a seat does, for the hover
 *  tooltip. Served from the same `SEAT_FACTS` the agent reads, so the two
 *  descriptions can't drift. */
export interface SeatBlurb {
  seat: string;
  label: string;
  role: string;
  traits: string[];
  /** Human-facing caveat; distinct from the agent-facing `note` in Rust. */
  hint?: string;
}

/** Human labels for the trait chips. An unknown trait falls back to its raw
 *  name rather than vanishing, so a new one added in Rust still shows. */
const TRAIT_LABELS: Record<string, string> = {
  interactive: "Interactive",
  background: "Background",
  latency_sensitive: "Latency-sensitive",
  long_context: "Long context",
  write_capable: "Can write",
};

export function traitLabel(name: string): string {
  return TRAIT_LABELS[name] ?? name.replace(/_/g, " ");
}

/** Mirrors Rust's `seatassign::ModelCheck`. */
export interface ModelCheck {
  model: string;
  ok: boolean;
  error?: string;
}

export type Posture = "cost" | "balanced" | "quality";

// The aliases and effort levels `claude --help` documents:
//   --effort <level>  Effort level for the current session (low, medium, high, xhigh, max)
//   --model <model>   Provide an alias for the latest model (e.g. 'fable', 'opus',
//                     or 'sonnet') or a model's full name (e.g. 'claude-fable-5').
// Aliases rather than pinned ids on purpose: an alias resolves to the latest
// model of that tier, so a seat chart built from them never goes stale. Kept
// here (not in the component) so the picker and the agent plumbing share one
// source of truth. Mirrors `seatassign::MODEL_ALIASES` / `EFFORT_LEVELS`.
export const MODEL_OPTIONS = ["fable", "opus", "sonnet", "haiku"];
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

export const POSTURES: { value: Posture; label: string; hint: string }[] = [
  {
    value: "cost",
    label: "Cost-conscious",
    hint: "Cheapest seat that can do the job; premium models only where needed.",
  },
  {
    value: "balanced",
    label: "Balanced",
    hint: "Spend where the work is hard or you lean on it; save elsewhere.",
  },
  {
    value: "quality",
    label: "Max quality",
    hint: "Prefer capability over cost, but leave idle seats at Default.",
  },
];

/** Run settings persisted through `set_ui_pref("seatAssignPrefs", …)`. */
export interface SeatAssignPrefs {
  posture: Posture;
  discretion: number;
}

export const DEFAULT_PREFS: SeatAssignPrefs = {
  posture: "balanced",
  discretion: 50,
};

/** Tolerant read of the stored blob — a corrupt or stale value falls back to
 *  the defaults rather than breaking the dialog. */
export function parsePrefs(raw: string | null | undefined): SeatAssignPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const v = JSON.parse(raw) as Partial<SeatAssignPrefs>;
    const posture = POSTURES.some((p) => p.value === v.posture)
      ? (v.posture as Posture)
      : DEFAULT_PREFS.posture;
    const n = typeof v.discretion === "number" ? Math.round(v.discretion) : NaN;
    return {
      posture,
      discretion: Number.isFinite(n)
        ? Math.min(100, Math.max(0, n))
        : DEFAULT_PREFS.discretion,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** The three discretion bands. Boundaries mirror
 *  `seatassign::discretion_band` exactly — the Rust side writes the agent's
 *  rule, this writes the human's caption, and both must split at 20/60. */
export function discretionBand(discretion: number): {
  label: string;
  caption: string;
} {
  const n = Math.min(100, Math.max(0, discretion));
  if (n <= 20) {
    return {
      label: "Follows your posture",
      caption: "Sticks to your posture even where the evidence disagrees.",
    };
  }
  if (n <= 60) {
    return {
      label: "Deviates only with reason",
      caption:
        "Your posture is the default; it may depart on a few seats and must say why.",
    };
  }
  return {
    label: "Uses its own judgment",
    caption:
      "Your posture is a hint; its read of your usage wins. Departures are still flagged.",
  };
}

function norm(v: string | undefined): string {
  return (v ?? "").trim();
}

/** The config that applying `pick` to `current` would produce.
 *
 *  `model` / `effort` / `fallback` are replaced wholesale, because the card
 *  shows the *resulting* state: applying a row with no effort must clear any
 *  effort already there. `backend`, `binaryPath` and `extraFlags` are outside
 *  the agent's reach and ride through untouched. Mirrors
 *  `seatassign::merge_pick`. */
export function applyPick(
  current: SeatConfig | undefined,
  pick: SeatPick,
): SeatConfig {
  const base = current ?? {};
  const out: SeatConfig = {
    backend: base.backend,
    binaryPath: base.binaryPath,
    extraFlags: base.extraFlags,
  };
  if (norm(pick.model)) out.model = norm(pick.model);
  if (norm(pick.effort)) out.effort = norm(pick.effort);
  if (norm(pick.fallback)) out.fallback = norm(pick.fallback);
  return out;
}

/** True when applying the pick would leave the seat exactly as it is. */
export function isNoOp(
  current: SeatConfig | undefined,
  pick: SeatPick,
): boolean {
  const base = current ?? {};
  return (
    norm(base.model) === norm(pick.model) &&
    norm(base.effort) === norm(pick.effort) &&
    norm(base.fallback) === norm(pick.fallback)
  );
}

/** Drop picks that would change nothing — the card only shows real changes.
 *  The agent is told not to emit these, but a chart is cheap to over-produce
 *  and the user should never see a row whose Apply is a no-op. */
export function changedPicks(
  seats: Record<string, SeatConfig>,
  picks: SeatPick[],
): SeatPick[] {
  return picks.filter((p) => !isNoOp(seats[p.seat], p));
}

/** Aliases always resolve, so only a custom id is worth a probe. Mirrors
 *  `seatassign::needs_preflight`. */
export function needsPreflight(model: string | undefined): boolean {
  const m = norm(model);
  return m !== "" && !MODEL_OPTIONS.includes(m);
}

/** The distinct model ids a chart needs probed. Deduped, and aliases excluded,
 *  so a thirteen-seat chart of aliases costs zero spawns. */
export function distinctPreflightModels(picks: SeatPick[]): string[] {
  const out: string[] = [];
  for (const p of picks) {
    const m = norm(p.model);
    if (needsPreflight(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

/** The pill under a seat row: "model · effort · ↳fallback". */
export function seatSummary(cfg: SeatConfig | undefined): string | null {
  if (!cfg) return null;
  const bits = [norm(cfg.model), norm(cfg.effort)].filter(Boolean);
  const fallback = norm(cfg.fallback);
  if (fallback) bits.push(`↳${fallback}`);
  return bits.length ? bits.join(" · ") : null;
}

/** How a pick reads in the card: "default → opus · high". */
export function pickTransition(
  current: SeatConfig | undefined,
  pick: SeatPick,
  defaultLabel: string,
): { from: string; to: string } {
  return {
    from: seatSummary(current) ?? defaultLabel,
    to: seatSummary(applyPick(current, pick)) ?? defaultLabel,
  };
}
