// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The four steps every session goes through — Ask → Claude plans → You
//! redline → Build — as one quiet line under the start screen's composer
//! (board 4a). It shows a first-time user the whole product before they have
//! used any of it, which is its only job: once any session has been approved
//! it has nothing left to teach, and App retires it for good (`anyApproved`
//! in lib/flowStart.ts, remembered so deleting that session never brings it
//! back).
//!
//! Numbered circles, the current step in the plan blue; the arrows between
//! them are decoration and say nothing to a screen reader, which hears an
//! ordered list with the current step marked.

import { ArrowRight } from "lucide-react";
import "./FlowStrip.css";

export type FlowStep = 1 | 2 | 3 | 4;

/** The steps' words. The second names the harness that writes the plan, so a
 *  Codex user isn't told Claude will. */
export function flowSteps(harness = "Claude"): readonly string[] {
  return ["Ask", `${harness} plans`, "You redline", "Build"];
}

export function FlowStrip({ step, harness }: { step: FlowStep; harness?: string }) {
  const steps = flowSteps(harness);
  return (
    <ol className="rl-flow-strip" aria-label="Every session, in four steps">
      {steps.map((label, i) => (
        <li key={label} aria-current={i + 1 === step ? "step" : undefined}>
          <span className="rl-flow-strip-n" aria-hidden="true">{i + 1}</span>
          {label}
          {i < steps.length - 1 && <ArrowRight size={12} className="rl-flow-strip-arrow" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

export default FlowStrip;
