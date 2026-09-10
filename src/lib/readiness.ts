// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { backendLabel, type Backend } from "./backendChoice";

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

/** Can this machine BUILD an extension pack? Advisory: planning one needs no
 *  toolchain, compiling it does. The dirs are the staged ABI/SDK/template of
 *  the checkout this binary was built from — what an extension launch grants
 *  via `--add-dir` (lib/launch.ts `extensionAddDirs`). */
export interface ExtensionToolchain {
  cargo: boolean;
  wasmTarget: boolean;
  abiDir: string | null;
  sdkDir: string | null;
  templateDir: string | null;
}

/** The codex half of the probe. Read ONLY when the stored backend choice is
 *  Codex — `found` and `usable` are different answers, and the gap between
 *  them is the live bug this shipped to close: `$PATH` on a machine with the
 *  ChatGPT desktop app usually resolves an older standalone build that has no
 *  `app-server` and no `resume`. */
export interface CodexProbe {
  found: boolean;
  path: string | null;
  source: string;
  usable: boolean;
  signedIn: boolean;
  version?: string | null;
  identity?: string | null;
  newerElsewhere?: { path: string; version: string } | null;
  configuredModel?: string | null;
  modelRunnable?: boolean | null;
  /** The config profile carrying the plan contract (`codex_profile.rs`).
   *  Optional so a probe predating the field is withheld, not guessed at. */
  profile?: { installed: boolean; outdated: boolean; path: string };
}

export interface ProviderProbe {
  found: boolean;
  path: string | null;
  source: string;
  usable: boolean;
  version?: string | null;
  identity: string;
  authentication: "signed-in" | "signed-out" | "unknown";
  hook: { installed: boolean; state: string; hooksPath: string; error?: string | null };
  skill: { installed: boolean; outdated: boolean; skillPath?: string };
}

/** Runtime probe from `preflight_status` (src-tauri/src/preflight.rs). */
export interface PreflightStatus {
  claude: { found: boolean; path: string | null; source: string; identity?: string | null };
  providers?: Partial<Record<Backend, ProviderProbe>>;
  /** Optional so a probe predating the field reads as "no answer" — every
   *  derivation from it is withheld rather than guessed at. */
  codex?: CodexProbe | null;
  curl: { ok: boolean; version: string | null };
  /** "active" | "ambient" | "paused" */
  mode: string;
  hook: { installed: boolean; conflictingUrl: string | null };
  skill: { installed: boolean; outdated: boolean };
  /** The Codex hook + skill installs. Withheld on the same condition as
   *  `codex`: reading either runs the codex capability probe, so a Claude
   *  user's payload carries neither. */
  codexHook?: {
    available: boolean;
    installed: boolean;
    hooksPath: string;
    stopFound: boolean;
    promptCaptureFound: boolean;
  } | null;
  codexSkill?: { installed: boolean; outdated: boolean } | null;
  /** Optional so a probe predating the field reads as "no answer" — every
   *  derivation from it is withheld rather than guessed at. Also null when
   *  the launch target isn't an extension pack: `rustup target list` is a
   *  child process and a plain build never needs the answer. */
  extension?: ExtensionToolchain | null;
}

export type ReadinessId =
  | "provider-missing" | "provider-logged-out" | "provider-integration-missing" | "codex-model-unavailable"
  | "mode-paused"
  | "claude-missing"
  | "codex-missing"
  | "codex-logged-out"
  | "codex-contract-missing"
  | "daemon-unbound"
  | "hook-unapproved"
  | "no-project"
  | "hook-missing"
  | "codex-hook-missing"
  | "skill-stale"
  | "curl-old"
  | "ext-toolchain";

/** What a fix button does. The surface maps each kind to the handler App
 *  already owns — no new backend paths. */
export type ReadinessFixKind =
  | "locate-provider"
  | "resume-mode"
  | "locate-claude"
  | "locate-codex"
  | "install-integration"
  | "new-project"
  | "copy-hooks";

export interface ReadinessFix {
  backend?: Backend;
  path?: string;
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
  targetBackend?: Backend;
  targetModel?: string | null;
  /** At dispatch every selected-provider integration must be able to return a plan. */
  requireIntegration?: boolean;
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
  /** ⏎'s resolved target is an extension-pack project (workspace registry
   *  kind). Gates the toolchain item so it never nags a plain build. */
  targetIsExtension?: boolean;
  /** ⏎ would launch on Codex. Every codex item is gated on this: a Claude
   *  user must never be shown a Codex blocker, and an extension launch is
   *  forced back onto Claude regardless of what is stored. */
  targetIsCodex?: boolean;
  /** Redline's Stop hook is installed in `~/.codex/hooks.json`
   *  (`get_codex_hook_status`). `undefined` while unprobed. */
  codexHookInstalled?: boolean;
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
  "codex-missing",
  "provider-missing",
  "provider-logged-out",
  "provider-integration-missing",
  "codex-model-unavailable",
  "codex-logged-out",
  "codex-contract-missing",
  "daemon-unbound",
  "hook-unapproved",
  "no-project",
  "hook-missing",
  "codex-hook-missing",
  "skill-stale",
  "curl-old",
  "ext-toolchain",
];

export function deriveReadiness(input: ReadinessInput): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const pf = input.preflight;
  const backend = input.targetIsExtension ? "claude-code" : input.targetBackend ?? (input.targetIsCodex ? "codex" : "claude-code");
  if (backend === "cursor" || backend === "antigravity") items.push(...providerReadiness(backend, pf));

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

  if (backend === "claude-code" && pf && !pf.claude.found) {
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

  // ── The Codex routes ───────────────────────────────────────────────────
  // All three gated on the stored choice: a Claude user must never see a
  // Codex blocker, and neither must a Claude launch out of an extension
  // project (those are forced back onto Claude at the door).
  if (input.targetIsCodex && pf) {
    const cx = pf.codex;
    if (!cx?.found || !cx.usable) {
      items.push({
        id: "codex-missing",
        state: "blocked",
        label: cx?.found
          ? "This `codex` is too old for Redline"
          : "Can't find the `codex` command",
        detail: cx?.found
          ? `${cx.path ?? "This installation"} needs updating. Plan approval requires ` +
            "Codex 0.154.0 or newer, with resume, discussion forks, and live " +
            "app-server support. Update Codex or choose a newer installation."
          : "Redline spawns Codex to do the planning. Install the ChatGPT " +
            "desktop app, or point Redline at the binary.",
        fix: { label: "Locate it…", kind: "locate-codex" },
      });
    } else if (cx.profile && (!cx.profile.installed || cx.profile.outdated)) {
      // The silent one. `codex -p redline-plan` with no such file is NOT an
      // error — codex ignores it — so the session would plan with no contract
      // at all: it looks perfect on v1 and destroys the track-changes diff on
      // v2, because nothing told it to preserve the block-identity sidecars.
      // Blocking, and blocking on `outdated` too: a stale contract fails the
      // same way, and the fix is the same one click.
      items.push({
        id: "codex-contract-missing",
        state: "blocked",
        label: cx.profile.outdated
          ? "The Codex planning integration is out of date"
          : "The Codex planning integration isn't installed",
        detail:
          "Install the current plan instructions and terminal launcher so " +
          "Codex can preserve your revisions and begin building when you approve.",
        fix: { label: "Install integration", kind: "install-integration", backend: "codex" },
      });
    } else if (!cx.signedIn) {
      // The third silent-failure route, and the one this strip exists for: a
      // present, hooked, logged-OUT codex spins forever over nothing.
      items.push({
        id: "codex-logged-out",
        state: "blocked",
        label: "Codex isn't signed in",
        detail:
          "A logged-out Codex starts, accepts the prompt, and then fails at " +
          "the first token — nothing would ever come back for review. Run " +
          "`codex login` in a terminal.",
        fix: { label: "codex login", kind: "copy-hooks", copyText: "codex login" },
      });
    }
    if (cx?.usable && !input.targetModel && cx.modelRunnable === false) {
      const newer = cx.newerElsewhere;
      items.push({ id: "codex-model-unavailable", state: "blocked",
        label: `Codex ${cx.version ?? "at this path"} can't run ${cx.configuredModel ?? "the configured model"}${newer ? ` — ${newer.version} is installed at ${newer.path}` : ""}`,
        detail: "Choose an available model or a newer Codex installation.",
        fix: { label: newer ? "Use newer Codex" : "Locate Codex…", kind: "locate-codex", path: newer?.path },
      });
    }
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
    (backend === "claude-code" || backend === "codex") &&
    input.pendingSince !== null &&
    input.now - input.pendingSince > HOOK_SILENCE_MS &&
    !input.planEverArrived
  ) {
    items.push({
      id: "hook-unapproved",
      state: "blocked",
      label: "The plan hook may not be approved yet",
      detail: backend === "codex"
        ? "Codex skips new or modified hooks until you trust their current definition. " +
          "Run /hooks in the Codex terminal and trust Redline’s Stop and UserPromptSubmit entries. " +
          "An installed hook is not necessarily trusted."
        : "Claude Code asks you to approve hooks once, from inside Claude " +
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
  if (backend === "claude-code" && pf && (!input.hookModalActive || input.requireIntegration) && !pf.hook.installed) {
    items.push({
      id: "hook-missing",
      state: input.requireIntegration || input.targetIsExtension ? "blocked" : "warn",
      label: pf.hook.conflictingUrl
        ? "Another hook took over ExitPlanMode"
        : "The plan hook was removed",
      detail: pf.hook.conflictingUrl
        ? `~/.claude/settings.json points ExitPlanMode at ${pf.hook.conflictingUrl}. Reinstalling merges Redline's entry back in.`
        : "Without it Claude Code never sends plans here. Reinstalling merges it back into ~/.claude/settings.json.",
      fix: { label: "Install integration", kind: "install-integration" },
    });
  }

  // Same shape as `hook-missing`, and only for a Codex launch. A warning
  // rather than a blocker because the plan still reaches the model — what is
  // lost is the return trip, which is exactly what the detail says.
  if (
    backend === "codex" &&
    (!input.hookModalActive || input.requireIntegration) &&
    input.codexHookInstalled === false
  ) {
    items.push({
      id: "codex-hook-missing",
      state: input.requireIntegration ? "blocked" : "warn",
      label: "The Codex plan hook isn't installed",
      detail:
        "Without it Codex never sends plans here. Installing it writes the " +
        "Stop hook into ~/.codex/hooks.json — Codex then asks you once to " +
        "trust the new hook, from inside Codex itself.",
      fix: { label: "Install integration", kind: "install-integration" },
    });
  }

  if (
    backend === "claude-code" &&
    pf &&
    (!input.hookModalActive || input.requireIntegration) &&
    (!pf.skill.installed || pf.skill.outdated)
  ) {
    items.push({
      id: "skill-stale",
      state: input.requireIntegration || input.targetIsExtension ? "blocked" : "warn",
      label: pf.skill.outdated
        ? "The Redline skills are out of date"
        : "The Redline skills were removed",
      detail:
        "They teach Claude how to present a plan and fold your revisions " +
        "back in. Plans still arrive without them — they just read worse.",
      fix: { label: "Install integration", kind: "install-integration" },
    });
  }

  // Only when ⏎ would land in an extension-pack project, and never blocking:
  // the plan session needs no cargo — `build.sh` does. Named before the user
  // spends a session finding out, which is this file's whole reason to exist.
  const ext = pf?.extension;
  if (input.targetIsExtension && ext && (!ext.cargo || !ext.wasmTarget)) {
    items.push({
      id: "ext-toolchain",
      state: "warn",
      label: ext.cargo
        ? "The wasm build target isn't installed"
        : "No Rust toolchain for building the extension",
      detail: ext.cargo
        ? "Planning works without it, but build.sh compiles for " +
          "wasm32-unknown-unknown. One command adds it."
        : "Planning works without it, but building the extension needs " +
          "cargo (rustup.rs installs it in one line).",
      fix: {
        label: "Copy the command",
        kind: "copy-hooks",
        copyText: ext.cargo
          ? "rustup target add wasm32-unknown-unknown"
          : "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      },
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

  if (backend === "codex" && input.requireIntegration && (!pf?.codexSkill?.installed || pf.codexSkill.outdated)) {
    items.push({ id: "skill-stale", state: "blocked", label: "The Codex review skill needs installation", detail: "Install the current plan revision contract before launching.", fix: { label: "Install integration", kind: "install-integration", backend } });
  }
  return sortReadiness(items).map(item => item.fix?.kind === "install-integration" ? { ...item, fix: { ...item.fix, backend } } : item);
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

export function providerReadiness(backend: Backend, pf: PreflightStatus | null): ReadinessItem[] {
  if (!pf || (backend !== "cursor" && backend !== "antigravity")) return [];
  const p = pf?.providers?.[backend];
  const label = backendLabel(backend);
  const bin = backend === "cursor" ? "agent" : "agy";
  if (!p?.found || !p.usable) return [{ id: "provider-missing", state: "blocked",
    label: p?.found ? `${label} CLI lacks required planning or resume capabilities` : `Can't find the ${label} CLI`,
    detail: `Locate a current ${bin} binary. The editor's launcher is a different command.`,
    fix: { label: "Locate it…", kind: "locate-provider", backend } }];
  if (p.authentication === "signed-out") return [{ id: "provider-logged-out", state: "blocked",
    label: `${label} isn't signed in`, detail: `Run ${backend === "cursor" ? "agent login" : "agy"} in your terminal to sign in.`,
    fix: { label: "Copy sign-in command", kind: "copy-hooks", copyText: `'${(p.path ?? bin).replace(/'/g, "'\\''")}'${backend === "cursor" ? " login" : ""}` } }];
  if (!p.hook.installed || !p.skill.installed || p.skill.outdated) return [{ id: "provider-integration-missing", state: "blocked",
    label: `${label} plan integration needs installation`,
    detail: p.hook.error ?? `Install the current review skills and hooks (${p.hook.state}).`,
    fix: { label: "Install integration", kind: "install-integration", backend } }];
  return [];
}

export function providerRestoreBlockers(backend: Backend, pf: PreflightStatus | null, codexHookInstalled?: boolean): ReadinessItem[] {
  return backend === "codex" ? codexRestoreBlockers(pf, codexHookInstalled).map(item => item.fix ? { ...item, fix: { ...item.fix, backend } } : item) : providerReadiness(backend, pf);
}

/** The Codex faults that make a RESTORE impossible.
 *
 *  A restore is a narrower thing than a launch, and it fails differently. The
 *  door's gate asks "can this machine start a plan session"; this one asks "can
 *  this machine resume THIS conversation and get the held plan back" — and the
 *  answer needs all four of these, because the restore is a round trip:
 *
 *  - the binary, and a current one: `codex resume` is the whole mechanism, and
 *    the `$PATH` build on a machine with the ChatGPT desktop app usually lacks
 *    it (that gap is why `usable` exists apart from `found`);
 *  - the sign-in, or the resumed session dies at the first token;
 *  - the plan profile, or the resumed session is never told the contract;
 *  - the Stop hook, or the sentinel it writes reaches nothing.
 *
 *  Lose any one and the reviewer gets a terminal that runs, looks fine, and
 *  never gives the plan back — with the detached banner dismissed behind it.
 *  So the restore refuses instead, and shows the same fix it would have shown
 *  at the door. */
const CODEX_RESTORE_IDS: readonly ReadinessId[] = [
  "codex-model-unavailable",
  "codex-missing",
  "codex-contract-missing",
  "codex-logged-out",
  "codex-hook-missing",
];

/** What stands between a detached Codex review and its plan coming back.
 *
 *  Deliberately built by running `deriveReadiness` rather than re-deriving the
 *  four items: the labels, details and fix actions are the ones the front door
 *  already ships, so a Codex probe that grows a new failure mode is answered in
 *  one place. The synthetic surroundings are the honest ones for a restore —
 *  it needs no project, no pending launch, and no plan to have ever arrived.
 *
 *  Empty while `preflight` is null. An unprobed machine has told us nothing,
 *  and refusing a restore on no answer would be worse than the fault it guards
 *  against: the reviewer's own terminal was always the fallback. */
export function codexRestoreBlockers(
  preflight: PreflightStatus | null,
  codexHookInstalled?: boolean,
): ReadinessItem[] {
  if (!preflight) return [];
  return deriveReadiness({
    preflight,
    daemonBound: true,
    hookModalActive: false,
    planEverArrived: true,
    pendingSince: null,
    now: 0,
    projectCount: 1,
    targetIsCodex: true,
    codexHookInstalled,
  })
    .filter((i) => CODEX_RESTORE_IDS.includes(i.id))
    // `codex-hook-missing` is a WARNING at the door, and correctly so: the
    // plan still reaches the model, only the return trip is lost. A restore is
    // nothing BUT the return trip, so here the same fault is fatal.
    .map((i) => (i.state === "blocked" ? i : { ...i, state: "blocked" as const }));
}

/** The blockers that apply to opening a CHAT.
 *
 *  A chat is a third case the two existing ones don't cover. The plan route
 *  gates on everything, because a plan has to be captured, approved through a
 *  hook, and land in a project. The Drafter gates on nothing, because opening a
 *  document spawns no process at all. Chat sits between: it DOES spawn
 *  `claude`, so a missing binary or a stolen daemon port really does mean the
 *  first message goes nowhere — but it needs no hook approval (nothing is
 *  captured), no project (it is unbound by design) and no interception mode
 *  (there is no plan to intercept). Reusing the plan gate would refuse a
 *  conversation for faults that cannot touch it; skipping it, as the Drafter
 *  does, would let the first message vanish silently. */
const CHAT_BLOCKERS: readonly ReadinessId[] = ["claude-missing", "daemon-unbound"];

export function chatBlockingItems(items: ReadinessItem[]): ReadinessItem[] {
  return blockingItems(items).filter((i) => CHAT_BLOCKERS.includes(i.id));
}
