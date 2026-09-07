// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Which harness restores a detached plan — and everything the reviewer is told
// about it.
//
// There are two restore paths and they must never disagree: the embedded
// terminal ("Restore plan session") and the clipboard fallback ("Copy resume
// command"). They differ only in where the command lands, so every decision
// upstream of that — which binary resumes, whether the reviewer still has to
// pick, and what the toast says — is made HERE, once, and read by both. A
// second copy of this reasoning is how a Codex reviewer ends up with a
// clipboard command that runs `claude --resume` on a thread id: no error, a
// silently FRESH conversation, and a phantom plan showing literal sentinel
// text.
//
// Pure. No Tauri, no React, no clock — the whole point is that it can be
// pinned by a test that costs nothing to run.

export type RestoreHarness = "claude-code" | "codex";

/** What `prepare_restore` resolved against the harness's own files.
 *
 *  Mirrors `ResumeTarget` in `src-tauri/src/lib.rs`. */
export interface RestorePrep {
  /** The cwd the resume must run from. */
  cwd: string | null;
  /** Is there a conversation on disk to resume into — and did we even look?
   *  Only the Claude arm ever answers anything but `unchecked`; see
   *  `RestoreHistory` in `src-tauri/src/lib.rs` for why this isn't a Boolean. */
  history: "available" | "missing" | "unchecked";
  /** The conversation lives somewhere other than the plan's project path. */
  relocated: boolean;
  /** Its plan file already holds the restore marker, so the resumed session has
   *  one tool call to make instead of three. Claude arm only. */
  primed: boolean;
}

export interface HarnessInput {
  /** Stored provenance, from `sessions.backend`. */
  backend?: string | null;
  /** What the reviewer picked in the detached banner. Only ever consulted for
   *  a row that has no stored provenance. */
  choice?: RestoreHarness | null;
}

export interface HarnessDecision {
  /** The harness this restore will actually use. */
  harness: RestoreHarness;
  /** Nothing was stored, so this is a guess (or the reviewer's own pick). The
   *  banner shows a harness choice when this is true — and only then, because
   *  asking a known-Codex reviewer which harness wrote their plan is asking
   *  them to confirm something Redline already knows. */
  legacy: boolean;
  /** True once a legacy row's reviewer has actually chosen. Separates "we are
   *  defaulting to Claude because we have nothing" from "they picked Claude". */
  chosen: boolean;
  /** The harness's name, for reviewer-facing copy. */
  label: string;
}

/** The full name, as a reviewer would say it. */
export function harnessLabel(h: RestoreHarness): string {
  return h === "codex" ? "Codex" : "Claude Code";
}

/** The short name for mid-sentence use ("Codex is no longer waiting"). */
export function harnessShortLabel(h: RestoreHarness): string {
  return h === "codex" ? "Codex" : "Claude";
}

/** Resolve the harness for a restore.
 *
 *  Stored provenance always wins: it came from the hook payload of the session
 *  that actually wrote the plan, which is the only witness there is. A reviewer
 *  cannot override it, because there is nothing to override — the conversation
 *  exists in exactly one harness's store.
 *
 *  A row with nothing stored is legacy (written before the `backend` column, or
 *  by a hook that didn't send a provider). Its id proves nothing: current Codex
 *  issues UUID session ids that are indistinguishable from Claude's, so
 *  sniffing the shape would be a coin flip dressed as a decision. So: ask, and
 *  until answered run the Claude path — which is precisely what every one of
 *  these rows did for its whole life. */
export function resolveRestoreHarness(input: HarnessInput): HarnessDecision {
  const stored = (input.backend ?? "").trim();
  if (stored) {
    const harness: RestoreHarness = stored === "codex" ? "codex" : "claude-code";
    return {
      harness,
      legacy: false,
      chosen: false,
      label: harnessLabel(harness),
    };
  }
  const harness = input.choice ?? "claude-code";
  return {
    harness,
    legacy: true,
    chosen: !!input.choice,
    label: harnessLabel(harness),
  };
}

/** A toast: what to say and how long to leave it up. */
export interface RestoreNote {
  message: string;
  ms: number;
}

/** Told once the resume command has gone into its terminal.
 *
 *  Read by the detached banner rather than a toast: the restore runs in a
 *  BACKGROUND terminal now, so there is no "below ↓" to point at and no moment
 *  where the reviewer sees the harness working. The banner they are already
 *  looking at becomes the progress surface, which is also why this copy no
 *  longer expires out from under them — `ms` survives for the callers that
 *  still toast. */
export function restoreStartedNote(
  d: HarnessDecision,
  prep: RestorePrep,
): RestoreNote {
  // The one genuinely bad outcome, and only Claude can report it: the
  // conversation isn't on disk, so the resume starts a FRESH session. The
  // restore still lands — the sentinel carries the held plan's id — but the
  // plan's history is gone from that session's context, and the reviewer is
  // owed the distinction. `unchecked` is NOT this: it means nobody looked.
  if (prep.history === "missing") {
    return {
      message:
        "No saved transcript for this session — reopening as a fresh " +
        "conversation, without the plan's history.",
      ms: 8000,
    };
  }
  return {
    message: `Reopening the ${d.label} session — the plan comes back when it answers.`,
    ms: 6000,
  };
}

/** The one thing the clipboard path owes a reviewer that the embedded path
 *  does not.
 *
 *  Redline hides the restore's raw terminal because a resumed session replays
 *  its earlier user turns, and Redline's own control events replayed back read
 *  as an accidental double-send. Outside Redline there is no presentation to
 *  manage: the reviewer's own terminal shows the conversation as the harness
 *  draws it, prior restore events and all. Say that — and say it as what it is,
 *  a difference in what is being *shown*. Nothing was removed from anyone's
 *  transcript, and claiming otherwise would be a lie about their own files. */
const EXTERNAL_PRESENTATION_NOTE =
  " Running outside Redline, so earlier restore events in that conversation " +
  "stay on screen — nothing was removed from it.";

/** Told after the resume command has been put on the clipboard. */
export function restoreCopiedNote(
  d: HarnessDecision,
  prep: RestorePrep,
): RestoreNote {
  if (prep.history === "missing") {
    return {
      message:
        "Copied — but there is no saved transcript for this session, so it " +
        "will resume as a fresh conversation without the plan's history." +
        EXTERNAL_PRESENTATION_NOTE,
      ms: 10000,
    };
  }
  return {
    message:
      `${d.label} resume command copied — paste it into a shell prompt.` +
      EXTERNAL_PRESENTATION_NOTE,
    ms: 10000,
  };
}

/** The detached banner's lede and body. The banner is the first thing a
 *  reviewer reads when their plan goes quiet; naming the wrong harness there
 *  turns a recoverable state into an apparent bug in Redline. */
export function detachedBannerCopy(d: HarnessDecision): {
  lede: string;
  body: string;
} {
  if (d.legacy && !d.chosen) {
    // Nothing stored and nothing picked. Claim neither harness — say the true
    // thing, which is that the hold is gone.
    return {
      lede: "This plan is no longer being held for review.",
      body:
        "The session that wrote it ended (or the hold timed out). Your " +
        "comments are preserved — pick the harness it was written in, then ",
    };
  }
  const who = harnessShortLabel(d.harness);
  return {
    lede: `${who} is no longer waiting for this plan.`,
    body:
      `The ${d.label} session ended (or the hold timed out). Your comments ` +
      "are preserved — ",
  };
}

/** The sidebar's `detached` pill tooltip. */
export function detachedPillTitle(backend?: string | null): string {
  const d = resolveRestoreHarness({ backend });
  const who = d.legacy ? "The session that wrote this plan" : `${d.label}`;
  const verb = d.legacy ? "is gone" : "is no longer waiting on this plan";
  return `${who} ${verb} — open the session and use “Restore plan session” before sending.`;
}
