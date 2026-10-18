// FLOW PLACEHOLDER — owned by topbar
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The mode chip's truth table: which of Chat / Plan mode / Redlining /
//! Building a session is in. The top bar's chip reads it for the open
//! session, the sidebar for every row (which live section a row sorts into,
//! and the colour its icon takes when it is the open one).
//!
//! This is the sidebar lane's stand-in with only what the sidebar reads; the
//! top bar lane owns the real table and the integrator keeps theirs. Anything
//! it adds must keep `sessionMode(input)` and `isBuildingRunState` answering
//! the same way for these inputs.

import type { SessionStatus } from "../types";

/** Chat · Plan mode · Redlining · Building. */
export type SessionMode = "chat" | "plan" | "redline" | "build";

export interface SessionModeInput {
  /** A chat (the headless companion), a terminal session whose plan has not
   *  arrived yet, or a plan session. */
  kind: "chat" | "launch" | "plan";
  status?: SessionStatus | null;
  runState?: string | null;
  /** Claude is mid-turn in this session's terminal. */
  working?: boolean;
}

/** An approved plan is being built: one agent in its terminal (`building`),
 *  or an orchestrated run that has not landed (`orchestrating`, `running`).
 *  `in_code_review` is a run waiting on YOU, so it is not building. */
export function isBuildingRunState(runState: string | null | undefined): boolean {
  return runState === "building" || runState === "orchestrating" || runState === "running";
}

export function sessionMode(input: SessionModeInput): SessionMode {
  if (input.kind === "chat") return "chat";
  // Before its plan exists a terminal session is Claude planning.
  if (input.kind === "launch") return "plan";
  if (isBuildingRunState(input.runState)) return "build";
  // A plan Claude is revising is back in Claude's hands.
  if (input.working) return "plan";
  if (input.status === "in_review") return "redline";
  return "plan";
}
