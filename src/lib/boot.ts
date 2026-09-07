// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Shell choreography: the doors-open boot and the snap-back settle.
//
// The boot animates the REAL pane containers (the .rl-plate elements) via a
// single attribute on <html> — there is no mirror layer, so the resting DOM
// is byte-identical to a boot that never ran. This module is the pure core:
// the phase machine, its timings, and the arm decision. The DOM writes live
// in main.tsx (arming, before React mounts) and useBootChoreography (the
// reveal-to-settled run); both stay thin enough to read as wiring.

/** The one attribute that drives the boot CSS. Values: "closed" (plates
 *  gathered over the document — the frame the window is revealed with) and
 *  "opening" (everything transitioning to identity). Removed at settle. */
export const BOOT_ATTR = "data-rl-boot";

/** sessionStorage key marking "this webview already played the boot" — a
 *  reload or HMR remount in the same tab must never replay the doors. */
export const BOOT_PLAYED_KEY = "redline.bootPlayed";

/** Hard budget for the opening run. The choreography settles on this timeout
 *  — never on transitionend, which a dropped frame or a mid-flight display
 *  change can swallow. The CSS stagger must finish inside it (the CSS's
 *  longest delay + duration; pinned by the source-invariant test below).
 *
 *  This is a DECORATIVE budget, not an interaction one. It used to be 750 ms
 *  and the shell waited it out: the front door rendered `visible={bootSettled
 *  && !loading}`, so every launch carried a fixed ~750 ms floor before the
 *  composer would even take focus. The floor is gone — nothing actionable
 *  reads the phase anymore — which is also what let the run itself shrink to
 *  a brisk plate resolve rather than a thing you sit through. */
export const BOOT_OPEN_MS = 300;

/** Module-scope dead-man switch armed in main.tsx alongside the attribute:
 *  if React never mounts, the attribute comes off on this timer and the
 *  native 2 s fallback show reveals today's static layout. Must outlast the
 *  longest legitimate run (opening + frame slack). */
export const BOOT_FAILSAFE_MS = 800;

/** How long `data-rl-snapback` rides <html> after ⌘⇧0 — the window in which
 *  the canonical jumps travel as one short fold (A3). */
export const SNAPBACK_SETTLE_MS = 320;

export type BootPhase = "closed" | "opening" | "settled";

export type BootEvent = "reveal" | "skip" | "timeout";

/** Arm only a real launch with motion allowed. Reduced motion means the
 *  attribute is never set at all — instant static layout, not a fast fade. */
export function shouldArm(i: {
  reducedMotion: boolean;
  alreadyPlayed: boolean;
}): boolean {
  return !i.reducedMotion && !i.alreadyPlayed;
}

// There is no first-launch "breath" anymore. It held the closed frame an
// extra 200 ms on a first-ever launch, which is 200 ms of a brand-new user
// looking at a frozen picture of an app — and the onboarding tour already
// supplies first-use pacing, deliberately and with something to read.

/** Pure phase step. "settled" is terminal and absorbing; skip and timeout
 *  settle from anywhere — the user's first keystroke or pointer press always
 *  outranks the choreography. */
export function advance(phase: BootPhase, event: BootEvent): BootPhase {
  if (phase === "settled") return "settled";
  if (event === "skip" || event === "timeout") return "settled";
  return phase === "closed" && event === "reveal" ? "opening" : phase;
}
