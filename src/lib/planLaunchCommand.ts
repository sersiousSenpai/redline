// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { shq } from "./resumeCommand";

/** Build the command that launches a *fresh* Claude Code plan-mode session
 *  seeded with a drafted prompt. The whole prompt rides as one single-quoted
 *  `claude` argument — `shq` handles embedded quotes, so a long multi-paragraph
 *  markdown brief passes through intact (the same pattern `buildResumeCommand`
 *  uses for its restore prompt).
 *
 *  `projectPath` pins the launch to a project directory. The embedded terminal
 *  already spawns in that cwd, so the `cd` is a harmless no-op there; it is the
 *  load-bearing fix for the copy-to-clipboard fallback, which the user may paste
 *  into a shell sitting anywhere. Omitted when no project is chosen — the
 *  spawned shell's own cwd ($HOME) is used.
 *
 *  Callers append a trailing `\r` to actually run the command in a PTY. */
export function buildPlanLaunchCommand(
  prompt: string,
  projectPath?: string | null,
): string {
  const launch = `claude --permission-mode plan ${shq(prompt)}`;
  return projectPath ? `cd ${shq(projectPath)} && ${launch}` : launch;
}
