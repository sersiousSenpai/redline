// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** Single-quote shell escaping: close the quote, emit an escaped literal
 *  quote, reopen. Safe for POSIX shells (the embedded PTY runs zsh). Exported
 *  so other terminal-launch builders (e.g. `planLaunchCommand`) escape arguments
 *  the exact same way — never hand-roll quoting. */
export const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The Codex config profile Redline launches and resumes plan sessions under
 *  (`codex -p <name>` → `~/.codex/<name>.config.toml`). It carries the plan
 *  contract as `developer_instructions`; Redline installs it beside the Codex
 *  hook. Mirrors `codex_profile::PROFILE` — `launchInvariants.test.ts` pins
 *  that the two agree, because a mismatch is silent on BOTH sides: codex
 *  ignores an unknown profile, and Redline would then run a plan session that
 *  was never told the revision contract. */
export const CODEX_PLAN_PROFILE = "redline-plan";

/** The wrapper owns a private app-server for this TUI. Its hooks inherit the
 * launch metadata; approval can address the live thread through its socket. */
export const codexPlanLauncher = (bin: string) =>
  '/bin/sh "${CODEX_HOME:-$HOME/.codex}/redline-codex-launch.sh" ' + shq(bin);

/** Bare marker the resumed session writes into its plan file on restore. Redline
 *  already holds the authoritative plan, so it re-presents that on restore and
 *  ignores the submitted body — Claude need not fetch or retype the plan. */
export const REDLINE_RESTORE_SENTINEL = "<!-- REDLINE_RESTORE -->";

/** The marker the resume command actually has Claude write: the bare sentinel
 *  with the *held plan's* session id appended. The daemon rebinds the restore to
 *  this id, so it works even when the ExitPlanMode handshake lands under a
 *  different session — `claude --resume` forks a new id, and a resume command
 *  pasted into an already-running Claude REPL runs under that REPL's own id.
 *  Must stay in sync with `REDLINE_RESTORE_PREFIX` / `restore_target_id` in
 *  `src-tauri/src/lib.rs`. */
export function restoreSentinel(sessionId: string): string {
  return `<!-- REDLINE_RESTORE:${sessionId} -->`;
}

/** The Agent Seat a restore's `claude` runs under.
 *
 *  The capture hook is a *command* hook, so it runs inside the resumed
 *  `claude`'s own environment and forwards this to the daemon as a header. It
 *  is what tells `/v1/prompts/ingest` that this prompt submission is a restore
 *  rather than a human typing, which is how the full protocol reaches the model
 *  as hidden `additionalContext` without ever appearing in the conversation.
 *
 *  Mirrors `restore_context::RESTORE_SEAT`. Unlike every other seat this one is
 *  deliberately NOT blanket machine-text: the env rides the whole process, and
 *  the reviewer may keep typing in that terminal after the restore lands. The
 *  daemon arms a one-shot per target instead, so exactly the trigger is treated
 *  as control traffic and everything the human types afterwards is captured
 *  normally. */
export const RESTORE_SEAT = "restore";

/** Environment the restore's `claude` carries, read by the capture hook at fire
 *  time and forwarded as headers. Narrow on purpose — the target's id, and the
 *  two facts that change what the handshake has to do. Mirrors the header names
 *  in `restore_context.rs`. */
export const RESTORE_ENV = {
  seat: "REDLINE_AGENT_SEAT",
  target: "REDLINE_RESTORE_TARGET",
  primed: "REDLINE_RESTORE_PRIMED",
  rescinded: "REDLINE_RESTORE_RESCINDED",
} as const;

/** `VAR=… VAR=… ` prefixed onto the `claude` invocation. Prefix assignments
 *  (rather than `export`) so the variables bind to this one process and vanish
 *  with it — a restore must not leave a marker behind in the reviewer's shell. */
function restoreEnvPrefix(
  sessionId: string,
  primed: boolean,
  rescinded: boolean,
): string {
  return (
    `${RESTORE_ENV.seat}=${shq(RESTORE_SEAT)} ` +
    `${RESTORE_ENV.target}=${shq(sessionId)} ` +
    `${RESTORE_ENV.primed}=${primed ? "1" : "0"} ` +
    `${RESTORE_ENV.rescinded}=${rescinded ? "1" : "0"} `
  );
}

/** What every restore trigger opens with, before the stamp.
 *
 *  Mirrors `restore_context::TRIGGER_PREFIX`, and the daemon requires it: the
 *  restore metadata rides the resumed process's ENVIRONMENT, so it is on every
 *  prompt that session submits — including the CLI's own injections, which fire
 *  `UserPromptSubmit` shaped exactly like a keystroke. The prefix is how the
 *  route tells Redline's one control event from everything else wearing the
 *  same environment. */
export const RESTORE_TRIGGER_PREFIX = "Redline restore · ";

/** Local "YYYY-MM-DD HH:MM" stamp the compact trigger opens with.
 *
 *  A resumed session replays its earlier user turns, so every prior restore of
 *  this plan is on screen alongside the new one. Unstamped they are byte-identical
 *  and read as one restore dispatched twice; stamped they read as what they are —
 *  two restores, hours apart. */
const restoreStamp = (now: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}`
  );
};

/** Compact form of the rescission clause. The resumed session's context still
 *  holds the ORCHESTRATE_STAND_DOWN deny ("this session's work is done"), and
 *  without a sentence voiding it a resumed claude obeys the stale stand-down
 *  instead of the restore — so it stays in the VISIBLE trigger rather than
 *  riding only the hidden context. `restore_context.rs` carries the full
 *  paragraph. */
const RESCINDED_CLAUSE =
  " The earlier Redline stand-down in your context is void — this plan is back " +
  "in review.";

/** The visible restore trigger: one compact, timestamped control event.
 *
 *  The operational protocol — why not to fetch the plan, why not to explore,
 *  what Redline does with the body — is real and the model needs it, but it is
 *  not conversation. It reaches the model as hidden `additionalContext` from
 *  `/v1/prompts/ingest` (see `restore_context.rs`), so the transcript records a
 *  single line instead of a paragraph the reviewer then sees replayed on every
 *  later resume.
 *
 *  This line must nonetheless stand ALONE. Hidden context improves precision;
 *  it is not allowed to become a single point of failure, so everything the
 *  handshake strictly requires is here: which call to make, the sentinel when
 *  Redline has not already written it, and the rescission void.
 *
 *  Two versions, for the same reason as before. When Redline has already
 *  written the marker into the session's plan file (`primed` — see
 *  `prime_plan_file`), the whole handshake is ONE tool call; otherwise the
 *  model writes the marker itself. Each step is a model round trip against a
 *  resumed session's full context — measured at 4-6 seconds apiece on a 1.7 MB
 *  transcript. */
const compactRestorePrompt = (
  sessionId: string,
  primed: boolean,
  stamp: string,
): string => {
  const head = `${RESTORE_TRIGGER_PREFIX}${stamp} — `;
  const body = primed
    ? "call ExitPlanMode now, as your very first action, with your plan file " +
      "exactly as it stands."
    : `write exactly \`${restoreSentinel(sessionId)}\` as your plan file's ` +
      "contents, then call ExitPlanMode.";
  // `--permission-mode plan` lands a RESUMED session in plan mode on 2.1.222
  // (it did not on 2.1.178), so this is a fallback clause, not a round trip.
  return (
    head +
    body +
    " Nothing else — Redline re-presents the plan it holds and ignores what " +
    "you submit. (Enter plan mode first if you are not in it.)"
  );
};

/** The "Restore plan session" command. Used both by the embedded terminal (with
 *  a trailing \r appended by the caller) and the copy-to-clipboard fallback.
 *
 *  `projectPath` pins the command to the plan's project directory. Claude scopes
 *  resumable sessions *per project*: `claude --resume <id>` run from any other
 *  cwd fails with "No conversation found" and interactive Claude falls back to a
 *  *fresh* session — which then writes the restore sentinel under an id Redline
 *  never held, surfacing as a phantom new plan showing literal sentinel text
 *  instead of the restored plan. The embedded terminal opens in this dir already
 *  (the cd is a harmless no-op there); it is the load-bearing fix for the
 *  copy-to-clipboard path, which the user may paste into a terminal sitting
 *  anywhere. */
export function buildResumeCommand(
  sessionId: string,
  now: Date,
  projectPath?: string | null,
  rescinded?: boolean,
  /** Redline wrote the marker into the plan file already, so the handshake is
   *  a single ExitPlanMode. Resolved by `prepare_restore`. Claude arm only —
   *  Codex has no plan file to prime. */
  primed?: boolean,
  /** Which harness holds this conversation, from `sessions.backend`.
   *
   *  Load-bearing, not decorative: `claude --resume` handed a Codex thread id
   *  does not error — it falls back to a FRESH session, which then writes the
   *  restore sentinel under an id Redline never held. That surfaces as a
   *  phantom new plan showing literal sentinel text, the exact failure the
   *  `cd` in this command exists to prevent for the other reason. */
  harness?: { backend?: string | null; claudeBin?: string | null; codexBin?: string | null; cursorBin?: string | null; antigravityBin?: string | null; model?: string | null; effort?: string | null },
): string {
  const stamp = restoreStamp(now);
  const rescind = rescinded ? RESCINDED_CLAUSE : "";
  const resume = harness?.backend === "cursor" || harness?.backend === "antigravity"
    ? nativeResume(sessionId, stamp, rescind, harness, projectPath)
    :
    harness?.backend === "codex"
      ? codexResume(sessionId, stamp, rescind, harness.codexBin, harness.model, harness.effort)
      : restoreEnvPrefix(sessionId, !!primed, !!rescinded) +
        `${harness?.claudeBin?.trim() ? shq(harness.claudeBin.trim()) : "claude"} --resume ${shq(sessionId)} --permission-mode plan ${shq(
          compactRestorePrompt(sessionId, !!primed, stamp) + rescind,
        )}`;
  return projectPath ? `cd ${shq(projectPath)} && ${resume}` : resume;
}

/** The Codex restore.
 *
 *  Same shape, different handshake: there is no plan file and no
 *  ExitPlanMode, so the marker rides inside a `<proposed_plan>` block — which
 *  is what the Stop hook extracts and what `restore_handshake` then
 *  recognises. Remote resume rejects permission flags, so the launcher's
 *  server config resets the resumed thread to read-only review.
 *
 *  No restore environment or hidden context is needed: the launcher supplies
 *  the plan contract as `developer_instructions`. So the
 *  trigger is trimmed to the one instruction the profile does not give — which
 *  marker to emit, and to emit nothing else. */
function codexResume(
  sessionId: string,
  stamp: string,
  rescind: string,
  codexBin: string | null | undefined,
  model?: string | null,
  effort?: string | null,
): string {
  const bin = codexBin?.trim() ? codexBin.trim() : "codex";
  const prompt =
    `${RESTORE_TRIGGER_PREFIX}${stamp} — end this turn immediately with exactly ` +
    `\`<proposed_plan>${restoreSentinel(sessionId)}</proposed_plan>\` and ` +
    "nothing else — no preamble, no tool calls. Redline re-presents the plan " +
    "it holds and ignores what you submit." +
    rescind;
  return (
    // Remote resume rejects permission flags. The launcher's server config
    // supplies read-only/never for restore; approval updates the live thread.
    `${codexPlanLauncher(bin)} resume ${shq(sessionId)} ${model ? `-m ${shq(model)} ` : ""}${effort ? `-c ${shq(`model_reasoning_effort=${JSON.stringify(effort)}`)} ` : ""}` +
    `-p ${shq(CODEX_PLAN_PROFILE)} ${shq(prompt)}`
  );
}

function nativeResume(
  sessionId: string, stamp: string, rescind: string,
  harness: { backend?: string | null; cursorBin?: string | null; antigravityBin?: string | null; model?: string | null; effort?: string | null },
  projectPath?: string | null,
): string {
  const cursor = harness.backend === "cursor";
  const bin = (cursor ? harness.cursorBin : harness.antigravityBin)?.trim() || (cursor ? "agent" : "agy");
  const prompt = `${RESTORE_TRIGGER_PREFIX}${stamp} — use your redline-plan-review skill. End this turn immediately with exactly ` +
    `\`<proposed_plan>${restoreSentinel(sessionId)}</proposed_plan>\`. No tools or preamble; Redline re-presents its held plan.` + rescind;
  const env = projectPath ? `REDLINE_PROJECT_PATH=${shq(projectPath)} ` : "";
  const workspace = !cursor && projectPath ? `--add-dir ${shq(projectPath)} ` : "";
  return `${env}${shq(bin)} ${cursor ? "--resume" : "--conversation"} ${shq(sessionId)} --mode=plan ${workspace}` +
    (harness.model ? `--model ${shq(harness.model)} ` : "") +
    (!cursor && harness.effort ? `--effort ${shq(harness.effort)} ` : "") + (!cursor ? "--prompt-interactive " : "") + shq(prompt);
}
