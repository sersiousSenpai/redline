// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Whether a plan session's CLI is still running in a terminal Redline kept
// through a quit (PTY helper P2). Only the terminal's foreground says so:
// the agent in front (the fleet poll's `fgComm`) is still running, and a
// Restore would run the conversation twice; the shell in front is a CLI
// that exited, and gets Restore and the automatic resume as before. Until
// the launch has heard from the helper, or the terminal's first sample has
// come in, it is unknown: neither "still running" nor Restore.

export type AgentLiveness = { state: "running"; label: string } | { state: "checking" } | null;

/** `agentInFront`: the terminal's last sample (TerminalStatus.agent),
 *  undefined before its first. */
export function agentLiveness(
  terminal: string | undefined,
  live: readonly string[] | null,
  front: boolean | undefined,
  label: string | undefined,
): AgentLiveness {
  if (live === null) return { state: "checking" };
  if (!terminal || !live.includes(terminal)) return null;
  if (front === undefined) return { state: "checking" };
  return front ? { state: "running", label: label || "its terminal" } : null;
}
