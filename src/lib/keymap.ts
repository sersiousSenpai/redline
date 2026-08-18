// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The app's keyboard shortcuts as data (A5). One declarative registry feeds
// every place a shortcut is *shown* — the command palette's hint column, the
// ShortcutHelp cheat sheets, the onboarding tour's shortcuts step — so a
// binding can't drift between the surfaces that describe it.
//
// Honest scope: only the two A5 globals (⌘K palette, ⌘⇧0 snap-back) are
// *dispatched* through the matchers below; every other entry documents an
// existing listener that still owns its own keydown handling (`wired: false`).
// Rewiring those long-proven listeners through a generic dispatcher would be
// churn without benefit — the registry's job is a single source of truth for
// what exists, not a new event system.

/** A cheat-sheet section: what `ShortcutHelp` renders. `keys` is
 *  space-separated caps ("⇧ ⌘ P" → three keycaps). Lives here — with the
 *  data — so the component depends on the registry, not the reverse. */
export interface ShortcutGroup {
  title: string;
  items: { keys: string; label: string }[];
}

export interface KeyBinding {
  id: string;
  /** Display keycaps, macOS-style (the app is a Mac app; Ctrl works too for
   *  the wired combos but the caps show the native chord). */
  keys: string[];
  label: string;
  /** Section in cheat-sheet/tour renderings. */
  group: "Global" | "Layout" | "Document";
  /** True when the combo is matched by this module's matchers (the two new
   *  globals). False entries are documentation of listeners that live
   *  elsewhere (App's pane/zoom effects). */
  wired: boolean;
}

export const GLOBAL_KEYMAP: KeyBinding[] = [
  { id: "palette", keys: ["⌘", "K"], label: "Command palette", group: "Global", wired: true },
  // The front door — the app's resting state, and the only path that clears
  // the session selection. It had no chord at all, which was survivable while
  // the sessions sidebar was always there carrying its row; it isn't, now that
  // the sidebar closes on every non-document surface. ⌘N is left alone because
  // Tauri/macOS read it as "new window".
  { id: "new-plan", keys: ["⌘", "⇧", "N"], label: "Plan a build", group: "Global", wired: true },
  { id: "snap-back", keys: ["⌘", "⇧", "0"], label: "Snap the layout back", group: "Layout", wired: true },
  { id: "pane-sidebar", keys: ["⇧", "←"], label: "Show / hide the sidebar", group: "Layout", wired: false },
  { id: "pane-discussion", keys: ["⇧", "→"], label: "Show / hide the discussion pane", group: "Layout", wired: false },
  { id: "pane-terminal", keys: ["⇧", "↓"], label: "Show / hide the terminal", group: "Layout", wired: false },
  { id: "sidebar-tabs", keys: ["⇧", "↑"], label: "Switch sidebar tabs", group: "Layout", wired: false },
  // Not a chord: on an immersive surface the periphery is hidden and the way
  // back is the top-edge hull rail (or ⌘⇧0, which lands on the document).
  // Documented here because the cheat sheet is where a user goes looking for
  // "how do I get the panels back" — the REVIEW_KEYMAP below already uses
  // gesture caps ("click", "drag") the same way.
  { id: "immersive", keys: ["hover"], label: "Show the panels on an immersive surface", group: "Layout", wired: false },
  { id: "zoom-in", keys: ["⌘", "+"], label: "Zoom the document in", group: "Document", wired: false },
  { id: "zoom-out", keys: ["⌘", "−"], label: "Zoom the document out", group: "Document", wired: false },
  { id: "zoom-reset", keys: ["⌘", "0"], label: "Reset the zoom", group: "Document", wired: false },
];

/** Hint keycaps for a binding id — the palette's hint column. */
export function bindingKeys(id: string): string[] | undefined {
  return GLOBAL_KEYMAP.find((b) => b.id === id)?.keys;
}

// ---- The two wired matchers -------------------------------------------------

export interface KeyComboInfo {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** ⌘K (or Ctrl+K) — open/close the command palette. Shift and Alt excluded so
 *  ⌘⇧K-style combos stay free for the future. */
export function isPaletteKey(e: KeyComboInfo): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.shiftKey || e.altKey) return false;
  return e.key === "k" || e.key === "K";
}

/** ⌘⇧0 — snap-back. Matched on e.code because Shift rewrites e.key
 *  ("0" → ")") on US layouts (see App's zoom listener, where this ran
 *  inline before A5 moved the decision here). */
export function isSnapBackKey(e: KeyComboInfo): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  return e.shiftKey && e.code === "Digit0";
}

/** ⌘⇧N — back to the front door. `e.code` for the same reason as snap-back
 *  (layout independence), and Alt excluded so ⌥⌘⇧N stays free. Plain ⌘N is
 *  deliberately NOT matched: macOS and Tauri both read it as "new window". */
export function isNewPlanKey(e: KeyComboInfo): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.altKey) return false;
  return e.shiftKey && e.code === "KeyN";
}

// ---- Renderings -------------------------------------------------------------

/** The onboarding tour's shortcuts step, straight from the registry. */
export function tourShortcuts(): { keys: string[]; text: string }[] {
  return GLOBAL_KEYMAP.map((b) => ({ keys: b.keys, text: b.label }));
}

/** ShortcutHelp-shaped groups for a global cheat sheet, registry-ordered.
 *  (`ShortcutHelp` splits `keys` on spaces into keycaps.) */
export function globalShortcutGroups(): ShortcutGroup[] {
  const order: KeyBinding["group"][] = ["Global", "Layout", "Document"];
  return order.map((title) => ({
    title,
    items: GLOBAL_KEYMAP.filter((b) => b.group === title).map((b) => ({
      keys: b.keys.join(" "),
      label: b.label,
    })),
  })).filter((g) => g.items.length > 0);
}

// The review pane's cheat sheet (moved from ReviewShortcutHelp so every
// shortcut description lives in this one registry). These document the review
// pane's own listeners — none are dispatched from here.
export const REVIEW_KEYMAP: ShortcutGroup[] = [
  {
    title: "Files",
    items: [
      { keys: "J", label: "Next file" },
      { keys: "K", label: "Previous file" },
      { keys: "V", label: "Toggle viewed (collapses)" },
      { keys: "X", label: "Collapse / expand file" },
      { keys: "⌘B", label: "Toggle file tree" },
    ],
  },
  {
    title: "Annotations",
    items: [
      { keys: "[", label: "Previous annotation" },
      { keys: "]", label: "Next annotation" },
      { keys: "click", label: "Select a line (row or +)" },
      { keys: "drag", label: "Select a range (gutter or text)" },
      { keys: "⇧click", label: "Extend the selection" },
    ],
  },
  {
    title: "Review",
    items: [
      { keys: "⌘F", label: "Find in diff" },
      { keys: "⌘↩", label: "Submit (while the agent waits)" },
      { keys: "⇧⌘P", label: "Commit & push…" },
      { keys: "?", label: "This help" },
    ],
  },
];
