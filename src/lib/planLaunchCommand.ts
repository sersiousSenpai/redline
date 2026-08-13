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

/** Build the *bare* launch for an Orchestrate terminal — deliberately carries
 *  no prompt. The multi-agent Workflow opt-in is gated on input *origin*
 *  (human-typed beats argv-positional), so the prompt is delivered separately
 *  as typed keystrokes (`buildOrchestratePrompt`) once claude's UI is up.
 *  `acceptEdits` because workflow subagents run there regardless of session
 *  mode; the model comes from the `orchestrator` seat (default `sonnet`) —
 *  every subagent inherits it, so an unset default would mean the big model
 *  × up-to-16 concurrent agents. */
export function buildOrchestrateLaunchCommand(
  projectPath: string | null | undefined,
  model: string,
): string {
  const launch = `claude --permission-mode acceptEdits --model ${shq(model)}`;
  return projectPath ? `cd ${shq(projectPath)} && ${launch}` : launch;
}

/** The orchestrator's typed prompt: ONE line, because Enter submits typed
 *  input — an embedded newline would fire the prompt early. The `ultracode`
 *  keyword and the natural-language "as a multi-agent workflow" ask are each
 *  a sufficient Workflow opt-in (belt and braces); the curl shape is the
 *  pre-authorized bridge GET, and the orchestrate skill carries the rest of
 *  the execution discipline. */
export function buildOrchestratePrompt(sessionId: string): string {
  return (
    `ultracode: execute the approved plan for Redline session ${sessionId} ` +
    `as a multi-agent workflow. First fetch it: ` +
    `curl -s "http://127.0.0.1:7676/v1/sessions/${sessionId}/plan" — ` +
    `rawPlanMarkdown is the reviewed, approved plan. ` +
    `Follow your orchestrate skill for the execution discipline.`
  );
}
