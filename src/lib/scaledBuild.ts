// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Scaled builds (Track O): the wire shapes of `scaled.rs` and the pure copy
// rules behind the pre-flight and pause cards. Dependency-free apart from
// the shared token formatter.

import { formatTokens } from "./orchestration";

import type { Scale } from "./teamBuildItems";
export type { Scale };

/** Mirror of `scaled::ScaleConfig`. */
export interface ScaleConfig {
  scale: Scale;
  maxAgents: number;
  /** Input + output + cache-write tokens; cache reads don't count. */
  tokenBudget: number;
  timeBudgetMins: number;
  leadModel: string;
  workerModel: string | null;
  scoutModel: string | null;
  effort: string | null;
  verify: boolean;
  steer: string | null;
}

export interface Limits { agents: number; tokens: number; minutes: number }
export type PauseReason = "agents" | "tokens" | "time";
export type Phase =
  | { kind: "launching" }
  | { kind: "preflight" }
  | { kind: "running" }
  | { kind: "paused"; reason: PauseReason }
  | { kind: "stopped"; reason: string };

export interface Preflight {
  name: string | null;
  description: string | null;
  phases: string[];
  callSites: number;
  dynamic: boolean;
  models: [string, number][];
  estimate: { agents: number; agentsExact: boolean; tokens: number; minutes: number };
  warnings: string[];
  script: string;
}

/** Mirror of `scaled::ScaledView`. */
export interface ScaledView {
  runId: string;
  planSessionId: string;
  config: ScaleConfig;
  limits: Limits;
  phase: Phase;
  startedAt: number | null;
  preflight: Preflight | null;
  usage: { agents: number; tokens: number; minutes: number };
}

/** What `scaled_build_start` hands back for the launch. */
export interface ScaledLaunch {
  runId: string;
  settingsPath: string;
  leadModel: string;
  effort: string | null;
  projectPath: string;
}

export function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "~4 agents · ~1.2M tokens · ~41 min", or "4+ agents …" for a per-item fan-out. */
export function estimateLabel(p: Preflight): string {
  const agents = p.estimate.agentsExact
    ? `~${p.estimate.agents} agent${p.estimate.agents === 1 ? "" : "s"}`
    : `${p.callSites}+ agents (some run per item)`;
  return `${agents} · ~${formatTokens(p.estimate.tokens)} tokens · ~${formatMinutes(p.estimate.minutes)}`;
}

export function limitsLabel(l: Limits): string {
  return `${l.agents} agents · ${formatTokens(l.tokens)} tokens · ${formatMinutes(l.minutes)}`;
}

export function pauseTitle(reason: PauseReason): string {
  switch (reason) {
    case "agents": return "The team build reached its agent cap";
    case "tokens": return "The team build reached its token budget";
    case "time": return "The team build reached its time budget";
  }
}

/** "8 of 8 agents", "5.1M of 5M tokens", "4 h of 4 h". */
export function usageAgainstLimit(v: ScaledView, reason: PauseReason): string {
  switch (reason) {
    case "agents": return `${v.usage.agents} of ${v.limits.agents} agents started; another wants to start`;
    case "tokens": return `${formatTokens(v.usage.tokens)} of ${formatTokens(v.limits.tokens)} tokens used`;
    case "time": return `${formatMinutes(v.usage.minutes)} of ${formatMinutes(v.limits.minutes)} elapsed`;
  }
}

/** What Extend raises the tripped limit to — the same rule as
 *  `RunCtl::extend` in scaled.rs (half again; at least +2 agents, +1M
 *  tokens, +30 min; never below current use). */
export function extendedLimit(v: ScaledView, reason: PauseReason): string {
  const l = v.limits;
  switch (reason) {
    case "agents": return `${l.agents + Math.max(2, Math.floor(l.agents / 2))} agents`;
    case "tokens": return `${formatTokens(Math.max(l.tokens, v.usage.tokens) + Math.max(1_000_000, Math.floor(l.tokens / 2)))} tokens`;
    case "time": return formatMinutes(Math.max(l.minutes, v.usage.minutes) + Math.max(30, Math.floor(l.minutes / 2)));
  }
}

// The menu entries live in `teamBuildItems.ts`: the Footer imports them on
// the boot path, and nothing else here needs to be there.
export { TEAM_BUILD_ITEMS, teamScaleOf } from "./teamBuildItems";
