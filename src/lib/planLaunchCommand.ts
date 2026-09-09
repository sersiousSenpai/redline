// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { BackendChoice } from "./backendChoice";
import { CODEX_PLAN_PROFILE, shq } from "./resumeCommand";

/** Build the command that launches a *fresh* plan session seeded with a
 *  drafted prompt — on either backend. THE only place a plan launch is built:
 *  `launchInvariants.test.ts` pins that, because a second construction site is
 *  how the three doors drifted apart the first time.
 *
 *  The whole prompt rides as one single-quoted argument — `shq` handles
 *  embedded quotes, so a long multi-paragraph markdown brief passes through
 *  intact (the same pattern `buildResumeCommand` uses for its restore prompt).
 *  Verified at size: a 113 KB Combine brief reaches the session byte-for-byte,
 *  because `pty_write_checked` paces the write and zsh's line editor keeps up
 *  (see `PTY_CHUNK_PAUSE`).
 *
 *  `projectPath` pins the launch to a project directory. The embedded terminal
 *  already spawns in that cwd, so the `cd` is a harmless no-op there; it is the
 *  load-bearing fix for the copy-to-clipboard fallback, which the user may paste
 *  into a shell sitting anywhere. Omitted when no project is chosen — the
 *  spawned shell's own cwd ($HOME) is used.
 *
 *  `addDirs` grants the session extra directories via `--add-dir` — one flag
 *  per dir so no dir is ever parsed as a second variadic value. The extension
 *  launch uses it for the staged ABI/SDK/template dirs a pack author needs to
 *  read: they sit outside the project cwd (inside the Redline checkout), and
 *  without the grant the session can't scout the contract it is building
 *  against. Plan mode still gates every write behind plan approval.
 *
 *  Callers append a trailing `\r` to actually run the command in a PTY. */
export function buildPlanLaunchCommand(
  prompt: string,
  projectPath?: string | null,
  addDirs: readonly string[] = [],
  /** Which harness, at what model/effort. Defaulted so every existing call
   *  site keeps producing byte-identical output — the claude-code arm with no
   *  flags IS today's command. */
  choice: BackendChoice = { backend: "claude-code", model: null, effort: null },
  /** Resolved absolute binaries. Only codex needs one (see below); claude
   *  still rides the login shell's `$PATH` as it always has. */
  bins: Partial<Record<BackendChoice["backend"], string | null>> = {},
  launchId?: string,
): string {
  const launch = choice.backend === "cursor" || choice.backend === "antigravity"
    ? nativePlanLaunch(prompt, choice, bins[choice.backend], projectPath)
    : choice.backend === "codex"
      ? codexLaunch(prompt, choice, bins.codex)
      : claudeLaunch(prompt, choice, addDirs, bins["claude-code"]);
  const env = (launchId ? `REDLINE_PLAN_LAUNCH_ID=${shq(launchId)} ` : "") +
    ((choice.backend === "cursor" || choice.backend === "antigravity") ? `REDLINE_PROJECT_PATH=${projectPath ? shq(projectPath) : '"$PWD"'} ` : "");
  const bound = env + launch;
  return projectPath ? `cd ${shq(projectPath)} && ${bound}` : bound;
}

/** Keep the contract compact: the canonical skill owns revision semantics. */
export const NATIVE_PLAN_PREFIX =
  "Use the installed redline-plan-review skill. Remain in read-only research and planning mode. " +
  "Finish with exactly one complete <proposed_plan>...</proposed_plan> envelope containing the full plan.\n\n";

function nativePlanLaunch(prompt: string, choice: BackendChoice, resolved?: string | null, projectPath?: string | null): string {
  const bin = resolved?.trim() || (choice.backend === "cursor" ? "agent" : "agy");
  const model = choice.model ? `--model ${shq(choice.model)} ` : "";
  const effort = choice.backend === "antigravity" && choice.effort ? `--effort ${shq(choice.effort)} ` : "";
  const workspace = choice.backend === "antigravity" && projectPath ? `--add-dir ${shq(projectPath)} ` : "";
  return `${shq(bin)} --mode=plan ${workspace}${model}${effort}${choice.backend === "antigravity" ? "--prompt-interactive " : ""}${shq(NATIVE_PLAN_PREFIX + prompt)}`;
}

function claudeLaunch(
  prompt: string,
  choice: BackendChoice,
  addDirs: readonly string[],
  resolved?: string | null,
): string {
  // Read-only research tools + Bash, pre-approved so a fresh plan session can
  // scout the project without surfacing a permission prompt per tool call — the
  // interactive counterpart to the `--allowedTools` allow-lists the agent spawns
  // (browse.rs / mission.rs / fork.rs / voice.rs) carry. The list sits *before*
  // `--permission-mode` so its variadic values are terminated by the next flag,
  // leaving the prompt as the sole positional arg. Plan mode still gates every
  // edit/write behind the user's plan approval, so Bash here only runs
  // read-style research commands before ExitPlanMode.
  //
  // `--model` / `--effort` sit ahead of `--allowedTools` for the same reason:
  // anything after it would have to be re-terminated. Both are omitted when
  // unset, so the default choice reproduces the legacy command byte for byte.
  const grants = addDirs.map((d) => `--add-dir ${shq(d)} `).join("");
  const model = choice.model ? `--model ${shq(choice.model)} ` : "";
  const effort = choice.effort ? `--effort ${shq(choice.effort)} ` : "";
  const bin = resolved?.trim() ? shq(resolved.trim()) : "claude";
  return `${bin} ${grants}${model}${effort}--allowedTools ${ALLOWED_TOOLS} --permission-mode plan ${shq(prompt)}`;
}

/** The Codex arm.
 *
 *  `-s read-only -a never` is the physical equivalent of
 *  `--permission-mode plan`: the session can read the repo and run research
 *  commands, but cannot write, and is never asked to approve anything. Codex's
 *  native Plan Mode is not reachable from the CLI (no flag starts the TUI in
 *  it), so the plan contract is injected as `developer_instructions` instead —
 *  a real top-level config key, verified string-typed.
 *
 *  **The contract rides in a config PROFILE, not on this line.** It was `-c
 *  developer_instructions='…'` first, and the command that produced was 6,476
 *  bytes: the macOS tty input queue is 1024 bytes, so the launch reached zsh
 *  truncated at byte 1023 and sat there unexecuted, with no error anywhere.
 *  `codex -p redline-plan` layers `~/.codex/redline-plan.config.toml`, which
 *  Redline installs beside the Codex hook (`codex_profile.rs`) — the command
 *  is ~200 bytes and the contract is delivered whole.
 *
 *  A missing profile file is NOT an error to codex — it is silently ignored,
 *  which would be a session that plans with no contract at all. That is why
 *  readiness blocks the door on `codex-contract-missing` rather than trusting
 *  this flag.
 *
 *  The binary is passed ABSOLUTE, unlike the claude arm. On a machine with the
 *  ChatGPT desktop app, `$PATH` usually still resolves `codex` to an older
 *  standalone install with no `resume` — which would boot, plan once, and then
 *  fail every restore. `resolve_codex_bin()` picks the app bundle; this uses
 *  what it picked.
 *
 *  `addDirs` is deliberately absent: Codex's `--add-dir` grants *write*
 *  access, which contradicts `-s read-only`. It is only used by extension-pack
 *  launches, and those stay on Claude in this pass. */
function codexLaunch(
  prompt: string,
  choice: BackendChoice,
  codexBin: string | null | undefined,
): string {
  const bin = codexBin?.trim() ? codexBin.trim() : "codex";
  const model = choice.model ? `-m ${shq(choice.model)} ` : "";
  const effort = choice.effort
    ? `-c ${shq(`model_reasoning_effort=${tomlString(choice.effort)}`)} `
    : "";
  return (
    `${shq(bin)} ${model}${effort}-s read-only -a never ` +
    `-p ${shq(CODEX_PLAN_PROFILE)} ${shq(prompt)}`
  );
}

/** Encode a value as a TOML *basic string* for `codex -c key=value`.
 *
 *  `-c` parses the value as TOML and only falls back to a raw literal when
 *  that fails — so an unquoted value that happens to parse (a bare number,
 *  `true`, something starting with `[`) is silently read as the wrong type,
 *  which is how `developer_instructions=12345` errors out as an integer.
 *  Mirrors `codex_profile::toml_string` on the Rust side. */
export function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
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
