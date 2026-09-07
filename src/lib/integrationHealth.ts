// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// One answer to "will a launch actually work on this machine", shared by every
// surface that needs it.
//
// The question has four askers with four different rhythms: boot (once, after
// the reveal), the settings panel (on open), the window-focus refresh (on every
// ⌘-tab back), and the launch boundary (on ⏎, which must not proceed on a
// guess). They used to probe independently — boot fired four separate status
// invokes plus a preflight, and each of those could spawn a child process for
// facts the others had just established. On a machine where `codex --help` is
// slow, the front door waited for it five times over.
//
// This module is the coordination, not the probing:
//
//   * **One in-flight probe.** Concurrent askers share a promise. Four callers
//     during boot produce one round trip, not four.
//   * **A short freshness window.** The things measured — a hook file, a
//     binary, curl — are edited OUTSIDE Redline while it sits in the
//     background, so the answer must not be cached forever. It also must not
//     be re-probed on every ⌘-tab back, which is what the ad-hoc 30s throttle
//     in App was defending against.
//   * **Keyed by the question.** "Is a Codex launch ready" and "is a Claude
//     launch ready" are different questions with different costs; a cached
//     Claude answer must never be handed to a Codex asker. A key change is a
//     cache miss, not a stale hit.
//   * **Explicitly invalidated** after an install, where the whole point is
//     that the answer just changed.
//
// The native half (`preflight_status`) does the same consolidation one layer
// down: one command, all probes concurrent, and nothing probed that the
// selected backend cannot need.

import { invoke } from "@tauri-apps/api/core";
import type { PreflightStatus } from "./readiness";
import type { Backend } from "./backendChoice";
import type { CodexHookStatus, HookStatus, SkillStatus } from "../types";

/** What `preflight_status` actually returns. `readiness.ts` declares the
 *  narrowest shape its derivations read — deliberately, so the pure module
 *  couples to nothing — but the payload carries the full status structs, and
 *  the setup surfaces need all of their fields. */
type PreflightPayload = PreflightStatus & {
  hook: HookStatus;
  skill: SkillStatus;
  codexHook?: CodexHookStatus | null;
  codexSkill?: SkillStatus | null;
};

/** Which launch this answer has to be true for. Probing is scoped to it: a
 *  Claude user's machine is never asked about codex, and a plain build is
 *  never asked about the Rust toolchain. */
export interface HealthQuery {
  /** The backend ⏎ would use. `null` means "both" — what a setup panel wants
   *  and a launch never does. */
  backend: Backend | null;
  /** ⏎'s target is an extension pack, the only case needing `cargo` +
   *  `wasm32-unknown-unknown`. */
  extension: boolean;
}

/** Everything the setup surfaces and the readiness derivation read. The codex
 *  halves are `null` when the query didn't ask for them — withheld, never
 *  fabricated, so a derivation cannot mistake a default for a real answer. */
export interface IntegrationHealth {
  preflight: PreflightStatus;
  hook: HookStatus;
  skill: SkillStatus;
  codexHook: CodexHookStatus | null;
  codexSkill: SkillStatus | null;
}

export type HealthProbe = (query: HealthQuery) => Promise<IntegrationHealth>;

/** How long an answer stays good. Long enough that ⌘-tabbing between Redline
 *  and a terminal doesn't re-probe on every trip; short enough that fixing
 *  something in that terminal and coming back shows the fix. */
export const HEALTH_TTL_MS = 30_000;

export interface HealthService {
  /** The current answer for `query`, probing only if there isn't a fresh one.
   *  Concurrent callers with the same key share one probe. */
  ensure(query: HealthQuery, now?: number): Promise<IntegrationHealth>;
  /** Probe regardless of freshness, still sharing with any in-flight probe of
   *  the same key. The focus refresh and the "I just fixed it" retry. */
  refresh(query: HealthQuery, now?: number): Promise<IntegrationHealth>;
  /** Drop the cache. Called after an install: the answer just changed, and
   *  serving the pre-install one would tell the user their fix did nothing. */
  invalidate(): void;
  /** The cached answer without probing — for a render that wants to show what
   *  is known so far and never to trigger work. */
  peek(query: HealthQuery, now?: number): IntegrationHealth | null;
}

const keyOf = (q: HealthQuery) => `${q.backend ?? "both"}|${q.extension}`;

export function makeHealthService(
  probe: HealthProbe,
  ttlMs = HEALTH_TTL_MS,
): HealthService {
  let inflight: { key: string; promise: Promise<IntegrationHealth> } | null =
    null;
  let cached: { key: string; at: number; value: IntegrationHealth } | null =
    null;
  // Bumped by `invalidate`. A probe that STARTED before the world changed is
  // an observation of the old world: its awaiters still get their answer (they
  // asked before the change too), but it must never become the cached one.
  // Without this, "install the hook, then invalidate + refresh" could join a
  // probe already in flight and cache its pre-install "still broken" — telling
  // the user their fix did nothing.
  let generation = 0;

  const fresh = (key: string, now: number) =>
    cached && cached.key === key && now - cached.at < ttlMs ? cached.value : null;

  function run(query: HealthQuery, now: number): Promise<IntegrationHealth> {
    const key = keyOf(query);
    // Share with an in-flight probe of the SAME question. A different key is a
    // different probe — letting a Codex asker await a Claude probe would hand
    // it an answer with no codex in it at all.
    if (inflight && inflight.key === key) return inflight.promise;
    const startedAt = generation;
    const promise = probe(query).then(
      (value) => {
        if (startedAt === generation) cached = { key, at: now, value };
        if (inflight?.promise === promise) inflight = null;
        return value;
      },
      (err) => {
        // A failed probe caches nothing: the next asker must try again rather
        // than inherit a silence. Nothing is swallowed — the rejection reaches
        // every sharer.
        if (inflight?.promise === promise) inflight = null;
        throw err;
      },
    );
    inflight = { key, promise };
    return promise;
  }

  return {
    ensure(query, now = Date.now()) {
      const hit = fresh(keyOf(query), now);
      return hit ? Promise.resolve(hit) : run(query, now);
    },
    refresh(query, now = Date.now()) {
      return run(query, now);
    },
    invalidate() {
      cached = null;
      // Disown the in-flight probe too, so the next `refresh` starts a real
      // one instead of joining an observation of the pre-change world.
      inflight = null;
      generation += 1;
    },
    peek(query, now = Date.now()) {
      return fresh(keyOf(query), now);
    },
  };
}

/** The real probe: one `preflight_status` call. It already carries the hook,
 *  skill and (when asked for) codex hook/skill statuses, so this is genuinely
 *  one IPC round trip — the four separate status invokes boot used to fire are
 *  gone, along with the duplicated `codex --help` between them. */
const invokeProbe: HealthProbe = async (query) => {
  const preflight = await invoke<PreflightPayload>("preflight_status", {
    backend: query.backend,
    extension: query.extension,
  });
  return {
    preflight,
    hook: preflight.hook,
    skill: preflight.skill,
    codexHook: preflight.codexHook ?? null,
    codexSkill: preflight.codexSkill ?? null,
  };
};

/** The process-wide service. One instance so the sharing is real — a second
 *  one would be a second in-flight probe wearing the same name. */
export const integrationHealth = makeHealthService(invokeProbe);
