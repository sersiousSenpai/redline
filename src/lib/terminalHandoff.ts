// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The verified terminal handoff. Every programmatic "open a terminal and type
// into it" used to be a blind `setTimeout(pty_write, 900)` — no ack, no
// await, no `.catch()` — against a backend whose unchecked write converts a
// missing terminal into success. A handoff that failed was indistinguishable
// from one that landed, which is how an orchestrated run once evaporated
// without a trace. This module replaces the guess with a checked sequence:
// wait for the real spawn signal, write through the checked command, observe
// the shell's output instead of assuming, and (for Orchestrate) confirm the
// prompt actually reached claude by watching for the ingest claim.
//
// Pure logic + injected deps so it is unit-testable without a PTY — the
// `activeSurface.ts` / `paneLayout.ts` house pattern. The deps are wired to
// `whenPtySpawned` / `awaitPtyOutput` (TerminalView) and the
// `pty_write_checked` / `get_run_state` Tauri commands at the call site.

/** Where a handoff can fail. `spawn` = the terminal never came up; `launch` =
 *  the first write (the shell command) was refused; `prompt` = the typed
 *  prompt never produced evidence of arrival. */
export type HandoffFailureStage = "spawn" | "launch" | "prompt";

export type HandoffResult =
  | { ok: true }
  | { ok: false; stage: HandoffFailureStage; reason: string };

/** One write into the terminal. When `awaitBefore` is set, the write waits
 *  for that output marker first; a marker that never appears falls back to a
 *  fixed settle and the write still goes — a missed marker is not proof the
 *  target is down, but a refused write is a hard failure. */
export interface HandoffStep {
  stage: "launch" | "prompt";
  data: string;
  awaitBefore?: RegExp;
  /** How long to wait for `awaitBefore` (ignored without it). */
  awaitTimeoutMs?: number;
  /** The settle used when `awaitBefore` times out. */
  fallbackSettleMs?: number;
}

/** What the handoff needs from the world, injected. */
export interface HandoffDeps {
  /** Resolves when the tab's `pty_spawn` settled OK; rejects on error/timeout. */
  whenSpawned(id: string, timeoutMs: number): Promise<void>;
  /** Registry membership — the rescue probe when the spawn signal is stale. */
  isLive(id: string): Promise<boolean>;
  /** The checked write: rejects when the terminal is not running. */
  writeChecked(id: string, data: string): Promise<void>;
  /** True when `match` appeared in the tab's output; false on timeout. */
  awaitOutput(id: string, match: RegExp, timeoutMs: number): Promise<boolean>;
  /** Fire-and-forget journal breadcrumb (`handoff_*` in context_journal). */
  journal(stage: string, detail?: string): void;
  sleep(ms: number): Promise<void>;
}

/** claude's TUI coming up — the marker the orchestrate prompt waits for,
 *  because claude enters raw mode and can discard bytes buffered before its
 *  init (the second failure window after the spawn race). Matched against the
 *  RAW output stream, so it lists banner strings across CLI generations: the
 *  v2.x boot banner ("Claude Code v2.1.222") and the persistent mode bar
 *  ("(shift+tab to cycle)") joined the older hints on 08/12, after the field
 *  showed 2.1.222 printing none of the originals — every orchestrate burned
 *  the full 30s timeout before the fallback settle typed anyway. None of
 *  these can match the echoed launch command (`cd … && claude --permission-
 *  mode …`), which is the text on screen before the TUI takes over. */
export const CLAUDE_READY =
  /\? for shortcuts|Welcome to Claude Code|Claude Code v\d|shift\+tab to cycle|╭─{3,}/;

/** A shell sitting at its prompt, ready to read a line.
 *
 *  The tty's line discipline buffers anything written before the shell's ZLE
 *  takes over, so a command written at spawn still RUNS — but it gets echoed
 *  twice: once raw by the tty as the bytes arrive, then again by the shell when
 *  it draws its prompt and redraws the line it inherited. The reviewer sees
 *  their restore command duplicated on screen, split by whatever the rc files
 *  printed in between (macOS's "Restored session:" banner, most visibly), and
 *  reads it as Redline having typed twice.
 *
 *  Waiting for the prompt costs nothing: the shell could not have run the
 *  command any earlier anyway — this only moves the write to after the echo
 *  is the shell's to make. Matches the tail of a prompt across the usual
 *  shells, tolerating the trailing colour/OSC sequences most themes emit.
 *
 *  Deliberately NOT applied to writes into a shell that is already up: there
 *  the prompt is long past and the wait would just burn its timeout. */
export const SHELL_PROMPT =
  /[%$#❯➜](?:\s| )(?:\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z])*$/;

/** How long to wait for it. A login shell reading its rc files takes well
 *  under a second; past that the prompt is not coming in a shape we know, and
 *  the write goes anyway — a doubled echo is a blemish, a skipped restore is a
 *  failure. */
export const PROMPT_TIMEOUT_MS = 4_000;

export interface HandoffOptions {
  spawnTimeoutMs?: number;
}

const SPAWN_TIMEOUT_MS = 15_000;
const READY_FALLBACK_MS = 1_500;

/** Deliver `steps` into terminal `id`, spawn-verified and write-checked.
 *  Replaces the 900 ms guess entirely: the tty line discipline buffers input
 *  written before zsh finishes its rc files, so once the PTY exists the first
 *  command can go immediately. */
export async function deliverToTerminal(
  deps: HandoffDeps,
  id: string,
  steps: HandoffStep[],
  opts?: HandoffOptions,
): Promise<HandoffResult> {
  try {
    await deps.whenSpawned(id, opts?.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS);
  } catch (e) {
    // The deferred can go stale (a failed first mount whose remount
    // succeeded) — believe the registry over the signal before giving up.
    const live = await deps.isLive(id).catch(() => false);
    if (!live) {
      return { ok: false, stage: "spawn", reason: String(e) };
    }
  }
  deps.journal("handoff_spawned");
  for (const step of steps) {
    if (step.awaitBefore) {
      const seen = await deps.awaitOutput(
        id,
        step.awaitBefore,
        step.awaitTimeoutMs ?? 30_000,
      );
      if (!seen) {
        // Missed marker ≠ dead target: fall back to the old fixed settle
        // and still write — the write itself is the checked act.
        await deps.sleep(step.fallbackSettleMs ?? READY_FALLBACK_MS);
      }
    }
    try {
      await deps.writeChecked(id, step.data);
    } catch (e) {
      return { ok: false, stage: step.stage, reason: String(e) };
    }
    deps.journal(
      step.stage === "launch" ? "handoff_launch_written" : "handoff_prompt_written",
    );
  }
  return { ok: true };
}

/** Timing knobs, injectable so tests run in microseconds. */
export interface OrchestrateTiming {
  spawnTimeoutMs: number;
  readyTimeoutMs: number;
  readyFallbackMs: number;
  /** Per-attempt window for the ingest claim to advance the run state. */
  claimTimeoutMs: number;
  claimPollMs: number;
  /** Prompt re-writes after the first attempt. */
  maxPromptRetries: number;
}

export const DEFAULT_ORCHESTRATE_TIMING: OrchestrateTiming = {
  spawnTimeoutMs: SPAWN_TIMEOUT_MS,
  readyTimeoutMs: 30_000,
  readyFallbackMs: READY_FALLBACK_MS,
  claimTimeoutMs: 20_000,
  claimPollMs: 1_000,
  maxPromptRetries: 2,
};

export interface OrchestrateDeps extends HandoffDeps {
  /** `sessions.run_state` for the plan session — the delivery probe. */
  getRunState(sessionId: string): Promise<string | null>;
  /** Re-register the launch guards before a prompt retry. Mandatory, not
   *  cosmetic: the orchestration guard expires on `GUARD_TTL` (300 s), so a
   *  slow approval of the workflow card would otherwise lose the claim. */
  rearm(): Promise<void>;
}

/** The full Orchestrate handoff: spawn → launch command → (claude ready) →
 *  prompt → confirm the ingest claim fired, retrying the prompt when it
 *  didn't. Delivery is not the goal; the claim is — *leaving*
 *  `orchestrating` is the only evidence a run actually started. */
export async function orchestrateHandoff(
  deps: OrchestrateDeps,
  id: string,
  planSessionId: string,
  launchCmd: string,
  prompt: string,
  timing?: Partial<OrchestrateTiming>,
): Promise<HandoffResult> {
  const t = { ...DEFAULT_ORCHESTRATE_TIMING, ...timing };
  const fail = (stage: HandoffFailureStage, reason: string): HandoffResult => {
    deps.journal("handoff_failed", `${stage}: ${reason}`);
    return { ok: false, stage, reason };
  };

  const launched = await deliverToTerminal(
    deps,
    id,
    [{ stage: "launch", data: `${launchCmd}\r` }],
    { spawnTimeoutMs: t.spawnTimeoutMs },
  );
  if (!launched.ok) return fail(launched.stage, launched.reason);

  // The readiness marker is only awaited once — a retry types into a claude
  // that is already up (the failure being retried is a lost prompt, not a
  // lost boot).
  const ready = await deps.awaitOutput(id, CLAUDE_READY, t.readyTimeoutMs);
  if (!ready) await deps.sleep(t.readyFallbackMs);

  const polls = Math.max(1, Math.ceil(t.claimTimeoutMs / t.claimPollMs));
  for (let attempt = 0; attempt <= t.maxPromptRetries; attempt++) {
    if (attempt > 0) {
      // Re-arm BEFORE re-typing: the guard is consume-once and TTL-bounded.
      try {
        await deps.rearm();
      } catch (e) {
        return fail("prompt", `re-arming the launch guards failed: ${String(e)}`);
      }
    }
    try {
      await deps.writeChecked(id, `${prompt}\r`);
    } catch (e) {
      return fail("prompt", String(e));
    }
    deps.journal("handoff_prompt_written", `attempt ${attempt + 1}`);

    for (let i = 0; i < polls; i++) {
      const state = await deps.getRunState(planSessionId).catch(() => null);
      if (state !== "orchestrating") {
        // The claim advanced the chip (or something else took over the
        // run) — either way the click is no longer the only evidence.
        return { ok: true };
      }
      await deps.sleep(t.claimPollMs);
    }
  }
  return fail(
    "prompt",
    "the orchestrator prompt was typed but no ingest claim ever arrived — " +
      "the run never left 'orchestrating'",
  );
}
