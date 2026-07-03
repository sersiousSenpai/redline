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
  // Read-only research tools + Bash, pre-approved so a fresh plan session can
  // scout the project without surfacing a permission prompt per tool call — the
  // interactive counterpart to the `--allowedTools` allow-lists the agent spawns
  // (browse.rs / mission.rs / fork.rs / voice.rs) carry. The list sits *before*
  // `--permission-mode` so its variadic values are terminated by the next flag,
  // leaving the prompt as the sole positional arg. Plan mode still gates every
  // edit/write behind the user's plan approval, so Bash here only runs
  // read-style research commands before ExitPlanMode.
  const launch = `claude --allowedTools ${ALLOWED_TOOLS} --permission-mode plan ${shq(prompt)}`;
  return projectPath ? `cd ${shq(projectPath)} && ${launch}` : launch;
}

/** Tools the launched plan session may use without prompting. Space-separated
 *  for the `--allowedTools` variadic flag, matching the agent-spawn convention. */
const ALLOWED_TOOLS = "Read Grep Glob WebSearch WebFetch Bash";
