// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The command palette's pure core (A5): a registry builder and a subsequence
// fuzzy scorer. No dependency on cmdk or any palette library — the matcher is
// ~30 lines and the small-binary ethos says a dependency has to earn more
// than that. React, focus, and overlay concerns live in CommandPalette.tsx;
// App.tsx supplies the closures. Everything here is data-in data-out.

import { bindingKeys } from "./keymap";

export interface PaletteCommand {
  id: string;
  title: string;
  /** Section header on the browse (empty-query) list; groups render as
   *  contiguous runs in registry order. */
  group: string;
  /** Muted line under the title (a session's project, "showing now"). Also
   *  searched by the fuzzy filter. */
  detail?: string;
  /** Hint keycaps from the keymap registry. */
  keys?: string[];
  run: () => void;
}

// ---- Fuzzy matching ---------------------------------------------------------

const SEPARATORS = new Set([" ", ":", "-", "–", "—", "/", ".", "(", "·"]);

/** Case-insensitive subsequence score: null = no match, higher = better.
 *  Word-starts and consecutive runs score up; gaps score down (capped, so a
 *  long title isn't punished for its tail). Spaces in the query are treated
 *  as separators, not characters to find — "theme stu" matches
 *  "Theme: Studio". The empty query matches everything at 0. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let from = 0;
  let prev = -2;
  let score = 0;
  for (const c of q) {
    if (c === " ") continue;
    const idx = t.indexOf(c, from);
    if (idx === -1) return null;
    if (idx === 0 || SEPARATORS.has(t[idx - 1])) score += 8;
    else if (idx === prev + 1) score += 5;
    score -= Math.min(idx - from, 10);
    prev = idx;
    from = idx + 1;
  }
  return score;
}

/** Filter + rank for a query; the empty query browses the registry in its
 *  authored order. Ties keep registry order (stable sort by index). */
export function rankCommands(
  commands: PaletteCommand[],
  query: string,
): PaletteCommand[] {
  if (!query.trim()) return commands.slice();
  const scored: { cmd: PaletteCommand; score: number; i: number }[] = [];
  commands.forEach((cmd, i) => {
    const hay = cmd.detail ? `${cmd.title} ${cmd.detail}` : cmd.title;
    const score = fuzzyScore(query, hay);
    if (score !== null) scored.push({ cmd, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.cmd);
}

// ---- The v1 registry --------------------------------------------------------

export interface PaletteSurfaceRef {
  id: string;
  label: string;
  title: string;
}

export interface PaletteSessionRef {
  id: string;
  title: string;
  project: string;
}

export interface PaletteChoiceRef {
  name: string;
  label: string;
}

export interface CommandDeps {
  /** From headerSurfaces(workspace) — manifest-hidden surfaces are already
   *  absent, so the palette can't resurrect them by construction. */
  surfaces: PaletteSurfaceRef[];
  currentSurface: string;
  sessions: PaletteSessionRef[];
  themes: PaletteChoiceRef[];
  currentTheme: string;
  fonts: PaletteChoiceRef[];
  currentFont: string;
  /** Enterable harnesses (empty while inside one — exit first). */
  harnesses?: { id: string; name: string }[];
  /** The harness the app is inside, if any. `exitHidden` = a boot entry
   *  (a flavored build IS its harness — no exit exists). */
  activeHarness?: { name: string; exitHidden: boolean } | null;
  actions: {
    draftNewPlan: () => void;
    openSession: (id: string) => void;
    selectSurface: (id: string) => void;
    snapBack: () => void;
    toggleSidebar: () => void;
    toggleDiscussion: () => void;
    toggleTerminal: () => void;
    /** Show / hide the periphery on an immersive (non-document) surface. */
    toggleImmersive: () => void;
    setTheme: (name: string) => void;
    setFont: (name: string) => void;
    zoomReset: () => void;
    replayTour: () => void;
    enterHarness?: (id: string) => void;
    exitHarness?: () => void;
  };
}

/** Assemble the v1 command set. Order is the browse order: the marquee
 *  action first, then plans, surfaces, layout, appearance, help. Closed
 *  lists throughout — themes/fonts/surfaces are what the deps hand over,
 *  never free-typed. */
export function buildCommands(deps: CommandDeps): PaletteCommand[] {
  const { actions } = deps;
  const commands: PaletteCommand[] = [];

  // One name for one place. The sidebar row, the divider pill and this entry
  // are three affordances for the same door, and three different labels for it
  // read as three different features.
  commands.push({
    id: "draft-new",
    title: "Plan a build",
    detail: "The front door",
    group: "Plans",
    keys: bindingKeys("new-plan"),
    run: actions.draftNewPlan,
  });
  for (const s of deps.sessions) {
    commands.push({
      id: `session:${s.id}`,
      title: `Open plan: ${s.title}`,
      group: "Plans",
      detail: s.project,
      run: () => actions.openSession(s.id),
    });
  }

  for (const s of deps.surfaces) {
    commands.push({
      id: `surface:${s.id}`,
      title: `Go to ${s.label}`,
      group: "Surfaces",
      detail: s.id === deps.currentSurface ? "showing now" : s.title,
      run: () => actions.selectSurface(s.id),
    });
  }

  // Harness mode — enter from anywhere the palette opens; exit only when an
  // exit exists (a boot-entered flavor hides it, so the command must too).
  if (actions.enterHarness) {
    for (const h of deps.harnesses ?? []) {
      commands.push({
        id: `harness:${h.id}`,
        title: `Enter harness: ${h.name}`,
        group: "Surfaces",
        run: () => actions.enterHarness!(h.id),
      });
    }
  }
  if (deps.activeHarness && !deps.activeHarness.exitHidden && actions.exitHarness) {
    commands.push({
      id: "harness-exit",
      title: `Exit ${deps.activeHarness.name}`,
      detail: "Back to Redline",
      group: "Surfaces",
      run: actions.exitHarness,
    });
  }

  commands.push(
    {
      id: "snap-back",
      title: "Snap the layout back",
      group: "Layout",
      keys: bindingKeys("snap-back"),
      run: actions.snapBack,
    },
    {
      id: "toggle-sidebar",
      title: "Show / hide the sidebar",
      group: "Layout",
      keys: bindingKeys("pane-sidebar"),
      run: actions.toggleSidebar,
    },
    {
      id: "toggle-discussion",
      title: "Show / hide the discussion pane",
      group: "Layout",
      keys: bindingKeys("pane-discussion"),
      run: actions.toggleDiscussion,
    },
    {
      id: "toggle-terminal",
      title: "Show / hide the terminal",
      group: "Layout",
      keys: bindingKeys("pane-terminal"),
      run: actions.toggleTerminal,
    },
    {
      id: "toggle-immersive",
      title: "Show / hide the panels on this surface",
      group: "Layout",
      keys: bindingKeys("immersive"),
      run: actions.toggleImmersive,
    },
    {
      id: "zoom-reset",
      title: "Reset the zoom",
      group: "Layout",
      keys: bindingKeys("zoom-reset"),
      run: actions.zoomReset,
    },
  );

  for (const t of deps.themes) {
    commands.push({
      id: `theme:${t.name}`,
      title: `Theme: ${t.label}`,
      group: "Appearance",
      detail: t.name === deps.currentTheme ? "current" : undefined,
      run: () => actions.setTheme(t.name),
    });
  }
  for (const f of deps.fonts) {
    commands.push({
      id: `font:${f.name}`,
      title: `Font: ${f.label}`,
      group: "Appearance",
      detail: f.name === deps.currentFont ? "current" : undefined,
      run: () => actions.setFont(f.name),
    });
  }

  commands.push({
    id: "replay-tour",
    title: "Replay the tour",
    group: "Help",
    run: actions.replayTour,
  });

  return commands;
}
