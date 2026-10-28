// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Entry of the full-App QA fixture: set the world up, then run the real
//! `src/main.tsx` — the same module, so App mounts exactly as it does in the
//! shipped window (theme pre-paint, StrictMode, the root error
//! boundary).
//!
//! Query parameters (scripts/app-visual-qa.mjs sets them):
//! - `board`: a scenario id or a scene name (scenarios.ts: `workbench` is
//!   the default; `home`, `plan`, `agent`… alias it; `4a`…`5a` are the
//!   original design-board seeds).
//! - `theme`: any theme name, written to `redline.theme` likewise.
//! - `motion`: `on` keeps animations; default `off` collapses every CSS
//!   animation and transition to 1ms, so a capture never lands mid-flight
//!   (1ms, not 0, so `transitionend` / `animationend` still fire).
//! - `clock`: `live` lets time run; default `frozen` pins `Date` to the
//!   scenario's `now`, so elapsed timers and relative dates are exact.
//!
//! Everything the App module graph touches is set up BEFORE the dynamic
//! import below: static imports here are only the fake backend and its data.

import { clock, installScenario, qa } from "./services";
import { scenarioFor } from "./scenarios";

const query = new URLSearchParams(location.search);
const scenario = scenarioFor(query.get("board"));

// A fresh profile per run, but the same tab reloads between scenarios:
// start every boot from empty storage so one board never leaks into the next.
localStorage.clear();
sessionStorage.clear();
for (const [key, value] of Object.entries(scenario.storage)) {
  localStorage.setItem(key, JSON.stringify(value));
}
for (const [key, value] of Object.entries(scenario.session)) {
  sessionStorage.setItem(key, JSON.stringify(value));
}
// A plain string, not JSON: applyTheme.ts reads it raw.
localStorage.setItem("redline.theme", query.get("theme") ?? "aurora");
// The doors-open boot choreography plays once per tab; mark it played.
sessionStorage.setItem("redline.bootPlayed", "1");

installScenario(scenario);

if (query.get("clock") !== "live") {
  clock.now = scenario.now;
  clock.frozen = true;
  const RealDate = Date;
  /** `Date` with the clock pinned: `new Date()` and `Date.now()` read
   *  `clock.now`; every other form is the real constructor. A subclass, so
   *  instances are real Dates and `instanceof Date` still holds. */
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.now);
      else super(...(args as [string | number | Date]));
    }
    static now(): number {
      return clock.now;
    }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
}

if (query.get("motion") !== "on") {
  const style = document.createElement("style");
  style.dataset.qa = "motion-off";
  style.textContent = `*, *::before, *::after {
    animation-duration: 1ms !important; animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important; transition-delay: 0s !important;
    caret-color: transparent !important;
  }`;
  document.head.append(style);
}

const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(String(e.error?.stack ?? e.message)));
window.addEventListener("unhandledrejection", (e) => errors.push(`unhandled rejection: ${String((e.reason as Error)?.stack ?? e.reason)}`));

(window as unknown as { __qa: unknown }).__qa = { ...qa, errors, board: scenario.id, booted: false };

void import("../../src/main.tsx").then(() => {
  (window as unknown as { __qa: { booted: boolean } }).__qa.booted = true;
});
