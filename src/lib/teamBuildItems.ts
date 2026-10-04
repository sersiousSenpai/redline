// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The team-build entries of the approve and Build menus. Their own module
// because the Footer is on the boot path; the cards' copy rules
// (`scaledBuild.ts`) stay in the lazy chunk.

export type Scale = "auto" | "custom";

/** One list, so the held and the approved plan's menus agree. */
export const TEAM_BUILD_ITEMS = [
  { id: "team:auto", label: "with a team · Auto", detail: "Redline previews the workflow, then caps it: 8 agents · 5M tokens · 4 h" },
  { id: "team:custom", label: "with a team · Custom…", detail: "set agents, models, effort, budgets and a steer" },
] as const;

export function teamScaleOf(id: string): Scale | null {
  return id === "team:auto" ? "auto" : id === "team:custom" ? "custom" : null;
}
