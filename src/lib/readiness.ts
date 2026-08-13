// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Is this machine actually able to deliver a plan? The front door promises
// "type a sentence and a real plan-mode session starts" — three routes break
// that promise silently today (an unapproved `/hooks`, Paused interception,
// and a missing `claude`), each of them presenting as a spinner over nothing.
// This is the pure derivation behind the strip that says so.
//
// The shape is deliberately negative: a HEALTHY item is not in the list at
// all, so a well machine yields `[]` and the strip renders nothing. There is
// no green checklist to dismiss — the door is either quiet or it is telling
// you something actionable.

/** Runtime probe from `preflight_status` (src-tauri/src/preflight.rs). */
export interface PreflightStatus {
  claude: { found: boolean; path: string | null; source: string };
  curl: { ok: boolean; version: string | null };
  /** "active" | "ambient" | "paused" */
  mode: string;
  hook: { installed: boolean; conflictingUrl: string | null };
  skill: { installed: boolean; outdated: boolean };
}

export type ReadinessId =
  | "mode-paused"
  | "claude-missing"
  | "daemon-unbound"
  | "hook-unapproved"
  | "no-project"
  | "hook-missing"
  | "skill-stale"
  | "curl-old";

/** What a fix button does. The surface maps each kind to the handler App
 *  already owns — no new backend paths. */
export type ReadinessFixKind =
  | "resume-mode"
  | "locate-claude"
  | "install-integration"
  | "new-project"
  | "copy-hooks";

export interface ReadinessFix {
  label: string;
  kind: ReadinessFixKind;
  /** `copy-hooks` carries the literal text the CopyChip copies. */
  copyText?: string;
}

export interface ReadinessItem {
  id: ReadinessId;
  /** `blocked` refuses ⏎; `warn` never does. */
  state: "blocked" | "warn";
  label: string;
  detail: string;
  fix?: ReadinessFix;
}

export interface ReadinessInput {
  /** Null until the first `preflight_status` resolves — every item derived
   *  from it is withheld rather than guessed at. */
  preflight: PreflightStatus | null;
  /** This window's daemon owns :7676. A second instance captures nothing. */
  daemonBound: boolean;
  /** `HookSetupModal` is up: it is unskippable and renders over everything,
   *  so the hook/skill items are unreachable by construction. */
  hookModalActive: boolean;
  /** A plan has landed in Redline at least once on this machine. */
  planEverArrived: boolean;
  /** When the front door launched the pending prompt (epoch ms), or null. */
  pendingSince: number | null;
  now: number;
  /** Known repos. Zero means a first-run user with nowhere to build. */
  projectCount: number;
}

/** How long a launch may sit with nothing arriving before we name the most
 *  likely cause. Claude Code's own `/hooks` approval is the one failure with
 *  no signal at all — nothing fires, nothing errors, the footer just waits. */
export const HOOK_SILENCE_MS = 90_000;

/** Fixed id order. The strip must never reshuffle under the cursor, so
 *  ordering is `blocked` first and then this list — never insertion order,
 *  which would move rows as probes resolve at different speeds. */
const ID_ORDER: ReadinessId[] = [
  "mode-paused",
  "claude-missing",
  "daemon-unbound",
  "hook-unapproved",
  "no-project",
  "hook-missing",
  "skill-stale",
  "curl-old",
];

export function deriveReadiness(input: ReadinessInput): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const pf = input.preflight;

  // ── The three silent-failure routes ────────────────────────────────────
  // Paused is the killswitch: the plan is auto-approved and captured NOT AT
  // ALL. A front door that launched into it would spin forever over nothing.
  if (pf?.mode === "paused") {
    items.push({
      id: "mode-paused",
      state: "blocked",
      label: "Redline is paused",
      detail:
        "Plans are auto-approved without ever reaching Redline. Nothing " +
        "you launch from here would come back for review.",
      fix: { label: "Resume interception", kind: "resume-mode" },
    });
  }
  // Ambient deliberately produces NO item: it isn't a fault. Its 20s
  // auto-approve countdown is handled at launch by claiming the arriving
  // decision window, so warning about it here would be pure noise.

  if (pf && !pf.claude.found) {
    items.push({
      id: "claude-missing",
      state: "blocked",
      label: "Can't find the `claude` command",
      detail:
        "Redline spawns Claude Code to do the planning. Install it, or " +
        "point Redline at the binary.",
      fix: { label: "Locate it…", kind: "locate-claude" },
    });
  }

  if (!input.daemonBound) {
    items.push({
      id: "daemon-unbound",
      state: "blocked",
      label: "Another Redline owns the plan port",
      detail:
        "This window couldn't bind 127.0.0.1:7676, so plans go to the other " +
        "instance. Quit it and relaunch.",
    });
  }

  if (
    input.pendingSince !== null &&
    input.now - input.pendingSince > HOOK_SILENCE_MS &&
    !input.planEverArrived
  ) {
    items.push({
      id: "hook-unapproved",
      state: "blocked",
      label: "The plan hook may not be approved yet",
      detail:
        "Claude Code asks you to approve hooks once, from inside Claude " +
        "Code itself — we can't do it for you. Run /hooks in the terminal " +
        "below and approve the Redline entry.",
      fix: { label: "/hooks", kind: "copy-hooks", copyText: "/hooks" },
    });
  }

  // ── Warnings ───────────────────────────────────────────────────────────
  if (input.projectCount === 0) {
    items.push({
      id: "no-project",
      state: "warn",
      label: "No project yet",
      detail:
        "Nothing to build in. Redline can make a folder for you and start " +
        "there.",
      fix: { label: "New project…", kind: "new-project" },
    });
  }

  // Recovery copy, not onboarding copy: on a true first run `HookSetupModal`
  // has already run and these are unreachable. Reaching them means the hook
  // was REMOVED later — via the app menu, or a foreign hook overwriting ours.
  if (pf && !input.hookModalActive && !pf.hook.installed) {
    items.push({
      id: "hook-missing",
      state: "warn",
      label: pf.hook.conflictingUrl
        ? "Another hook took over ExitPlanMode"
        : "The plan hook was removed",
      detail: pf.hook.conflictingUrl
        ? `~/.claude/settings.json points ExitPlanMode at ${pf.hook.conflictingUrl}. Reinstalling merges Redline's entry back in.`
        : "Without it Claude Code never sends plans here. Reinstalling merges it back into ~/.claude/settings.json.",
      fix: { label: "Install integration", kind: "install-integration" },
    });
  }

  if (
    pf &&
    !input.hookModalActive &&
    (!pf.skill.installed || pf.skill.outdated)
  ) {
    items.push({
      id: "skill-stale",
      state: "warn",
      label: pf.skill.outdated
        ? "The Redline skills are out of date"
        : "The Redline skills were removed",
      detail:
        "They teach Claude how to present a plan and fold your revisions " +
        "back in. Plans still arrive without them — they just read worse.",
      fix: { label: "Install integration", kind: "install-integration" },
    });
  }

  if (pf && !pf.curl.ok) {
    items.push({
      id: "curl-old",
      state: "warn",
      label: "curl is older than 8.3",
      detail:
        `Found ${pf.curl.version ?? "no version"}. Agents that write back ` +
        "into Redline (in-document replies, tracked suggestions) need " +
        "--variable/--expand-header. Reviewing plans is unaffected.",
    });
  }

  return sortReadiness(items);
}

/** `blocked` before `warn`, then the fixed id order. Exported for the test
 *  that pins the law itself rather than one derivation of it. */
export function sortReadiness(items: ReadinessItem[]): ReadinessItem[] {
  const rank = (i: ReadinessItem) => (i.state === "blocked" ? 0 : 1);
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) || ID_ORDER.indexOf(a.id) - ID_ORDER.indexOf(b.id),
  );
}

/** The items that refuse ⏎, in the order the composer should surface them. */
export function blockingItems(items: ReadinessItem[]): ReadinessItem[] {
  return items.filter((i) => i.state === "blocked");
}
