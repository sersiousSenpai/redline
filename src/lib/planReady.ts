// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The "Plan ready" card's one line of size (board 4c: "3 sections · 11
//! steps."), read from the plan's markdown so the card can say how much
//! there is to redline before anyone opens it.

/** "3 sections · 11 steps." from a plan's markdown: its `##` sections, and
 *  the list items under them. Null for a plan with neither. */
export function planReadySummary(markdown: string): string | null {
  let sections = 0;
  let steps = 0;
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (/^##\s/.test(line)) sections += 1;
    else if (sections > 0 && /^\s*(\d+[.)]|[-*+])\s+\S/.test(line)) steps += 1;
  }
  const parts = [
    sections > 0 ? `${sections} section${sections === 1 ? "" : "s"}` : null,
    steps > 0 ? `${steps} step${steps === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}.` : null;
}
