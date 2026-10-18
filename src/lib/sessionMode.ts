// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What a session is doing, as the one word the flow shell wears for it: the
//! top bar's mode chip, the sidebar row's icon tint, the stage's status. Four
//! modes and nothing else — Chat, Plan mode, Redlining, Building vN — because
//! a first-time user asked "where is plan mode?" and the answer has to be the
//! same word in every place it shows.
//!
//! Pure: the callers hand over what they already hold (the session summary's
//! status, hold and run state, whether a revision is being written, the CLI's
//! own permission mode once the conversation mirror has reported it), and
//! read back a label and a tone. The rules, first match wins:
//!
//! - nothing chosen (the New-session screen) → no chip;
//! - a chat → Chat;
//! - an approved plan → the build family, numbered by the approved version:
//!   Building while the same agent or a run is on it (or stalled in it),
//!   Built once it landed, Approved while nothing has started it;
//! - a plan held for your review → Redlining;
//! - a plan being revised, or a CLI that reports plan mode → Plan mode;
//! - any other plan in review → Redlining (it is still yours to mark);
//! - a launch with no plan yet → Plan mode, unless the CLI has said it left
//!   plan mode (then it is a conversation: Chat).

import type { ConvoMode } from "./convo/types";
import type { SessionStatus } from "../types";
import { latestDisplayVersion } from "./revisionVersions";

export type ModeKind = "chat" | "plan" | "redline" | "build";

export interface SessionMode {
  kind: ModeKind;
  /** The chip's words: "Plan mode", "Redlining", "Building v4"… */
  label: string;
  /** The version a build-family label names; absent for the other modes. */
  version?: number;
}

/** What the stage is pointed at, as far as the mode cares. Mirrors the
 *  stage's `StageTarget` kinds, plus a chat. */
export type ModeTarget = "start" | "launch" | "plan" | "chat";

export interface SessionModeInput {
  target: ModeTarget;
  /** A plan session's status; ignored for the other targets. */
  status?: SessionStatus | null;
  /** A POST is held for this plan: Claude is waiting on your review. */
  held?: boolean;
  /** Feedback went out and Claude is writing the next revision. */
  revising?: boolean;
  /** The session's revisions, oldest first: the build family's vN. */
  revisions?: ReadonlyArray<{ versionNumber: number; restored?: boolean }>;
  /** `SessionSummary.runState`: building | orchestrating | running |
   *  in_code_review | landed | stalled, or null for a plain approve. */
  runState?: string | null;
  /** The CLI's own permission mode, from the conversation mirror's latest
   *  `mode_change`; null or absent until it has reported one. */
  cliMode?: ConvoMode | null;
}

/** Run states in which the approved plan is still being built. `stalled`
 *  counts: the build has not finished, it has stopped making progress, and
 *  the plan footer says which. */
const BUILDING_STATES = new Set(["building", "orchestrating", "running", "in_code_review", "stalled"]);

export function sessionMode(input: SessionModeInput): SessionMode | null {
  switch (input.target) {
    case "start":
      return null;
    case "chat":
      return { kind: "chat", label: "Chat" };
    case "launch":
      return input.cliMode && input.cliMode !== "plan"
        ? { kind: "chat", label: "Chat" }
        : { kind: "plan", label: "Plan mode" };
    case "plan":
      return planMode(input);
  }
}

function planMode(input: SessionModeInput): SessionMode | null {
  if (input.status === "approved") {
    const revisions = (input.revisions ?? []).map((r) => ({ versionNumber: r.versionNumber, restored: !!r.restored }));
    // The substantive version, as the version pill counts it: a restore
    // re-presents a version, it does not make a new one.
    const version = latestDisplayVersion(revisions, revisions[revisions.length - 1]?.versionNumber ?? 1);
    const runState = input.runState ?? null;
    const word = runState === "landed" ? "Built" : runState && BUILDING_STATES.has(runState) ? "Building" : "Approved";
    return { kind: "build", label: `${word} v${version}`, version };
  }
  if (input.held) return { kind: "redline", label: "Redlining" };
  if (input.revising || input.cliMode === "plan") return { kind: "plan", label: "Plan mode" };
  // Aborted: Claude stopped and nothing holds the plan. Without a live CLI
  // saying otherwise there is no mode to name.
  if (input.status === "aborted") return null;
  return { kind: "redline", label: "Redlining" };
}

/** The tokens a mode paints with. Chat has no mode colour of its own: it
 *  sits in the neutral chip fill. */
export function modeColors(kind: ModeKind): { fg: string; bg: string } {
  switch (kind) {
    case "plan":
      return { fg: "var(--color-mode-plan-fg)", bg: "var(--color-mode-plan-bg)" };
    case "redline":
      return { fg: "var(--color-mode-redline-fg)", bg: "var(--color-mode-redline-bg)" };
    case "build":
      return { fg: "var(--color-mode-build-fg)", bg: "var(--color-mode-build-bg)" };
    case "chat":
      return { fg: "var(--color-ink-3)", bg: "var(--color-fill-2)" };
  }
}

/** A plan session's display name, the way the sidebar names its row: the
 *  user's rename, the plan's own heading, then where it lives. */
export function sessionTitle(s: {
  sessionId: string;
  titleOverride?: string | null;
  planTitle?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
}): string {
  return s.titleOverride || s.planTitle || s.projectName || s.projectPath || s.sessionId;
}

/** A launch's provisional title: the prompt's first line, until the plan
 *  (or the CLI's own title) names it. */
export function launchTitle(prompt: string): string {
  const line = prompt.trim().split("\n", 1)[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line || "New session";
}

// ── "● N needs you" ────────────────────────────────────────────────────────
// The top bar's count of what is waiting on you somewhere else: held plans,
// terminals blocked on a question or a permission, and a code-review request
// holding its agent. Never the session on screen (boards 4c and 4d hold the
// open plan and draw no pill; 5a counts another session's question while you
// read Dialcrown), and a held plan's own terminal once, as its plan.

export interface NeedsYouInput {
  summaries: ReadonlyArray<{
    sessionId: string;
    held: boolean;
    heldTerminalId?: string | null;
    archivedAt?: number | null;
  }>;
  /** Terminals in the needs-you state proper, oldest first. */
  needsYouTerminals: readonly string[];
  /** A `/redline-code-review` request is holding its agent. */
  reviewHold: boolean;
  /** The plan session the stage shows, or null (start, a launch, a chat). */
  activeSessionId: string | null;
  /** The terminal the stage's session runs in, or null. */
  activeTerminalId: string | null;
}

export interface NeedsYou {
  count: number;
  /** Where "● N needs you" goes first: held plans, then terminals, then the
   *  review. */
  plans: string[];
  terminals: string[];
  review: boolean;
}

export function needsYou(input: NeedsYouInput): NeedsYou {
  const held = input.summaries.filter(
    (s) => s.held && !s.archivedAt && s.sessionId !== input.activeSessionId,
  );
  const heldTerminals = new Set(held.map((s) => s.heldTerminalId).filter(Boolean));
  const terminals = input.needsYouTerminals.filter(
    (id) => id !== input.activeTerminalId && !heldTerminals.has(id),
  );
  const plans = held.map((s) => s.sessionId);
  return {
    count: plans.length + terminals.length + (input.reviewHold ? 1 : 0),
    plans,
    terminals,
    review: input.reviewHold,
  };
}

/** Whether an approved plan is being built right now: one agent in its
 *  terminal (`building`) or an orchestrated run that has not landed
 *  (`orchestrating`, `running`). Narrower than the chip's Building — a run
 *  in code review is waiting on YOU and a stalled one has stopped — so it is
 *  what the sidebar's Building section and its spinners key on. */
export function isBuildingRunState(runState: string | null | undefined): boolean {
  return runState === "building" || runState === "orchestrating" || runState === "running";
}
