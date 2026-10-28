// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The app's keyboard shortcuts as data (A5). One declarative registry feeds
// every place a shortcut is *shown* — the command palette's hint column, the
// ShortcutHelp cheat sheets, the onboarding tour's shortcuts step — so a
// binding can't drift between the surfaces that describe it.
//
// Honest scope: only the wired globals (⌘K palette, ⌘⇧N new plan, ⇧⏎ front
// door, ⌘⇧0 snap-back, ⌘J the rail's Talk, ⌘⇧J needs-you jump), the
// workbench's tab chords (WORKBENCH_KEYMAP: ⌘T / ⌘⇧T / ⌘W / ⌘⇧W, ⌘1–9,
// ⌘⌥←→ and ⌘⇧[]) use the matchers below; every other entry documents an existing listener that still owns its
// own keydown handling (`wired: false`). The workbench chords are native menu
// items too (src-tauri workbench_menu.rs), the only mechanism that fires
// while an embedded web page has focus; the matchers here are the same chords
// for a page with no native menu (a web preview, a menu that failed to
// install) and for the ⌘⌥←→ aliases, which no menu item can carry.
// Rewiring those long-proven listeners through a generic dispatcher would be
// churn without benefit — the registry's job is a single source of truth for
// what exists, not a new event system.

import { HOLD_KEYS, loadHoldKey } from "../audio/holdKey";

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
  { id: "front-door", keys: ["⇧", "⏎"], label: "Open the front door (outside a text field)", group: "Global", wired: true },
  // The front door — the app's resting state, and the only path that clears
  // the session selection. It had no chord at all, which was survivable while
  // the sessions sidebar was always there carrying its row; it isn't, now that
  // the sidebar closes on every non-document surface. ⌘N is left alone because
  // Tauri/macOS read it as "new window".
  { id: "new-plan", keys: ["⌘", "⇧", "N"], label: "Plan a build", group: "Global", wired: true },
  { id: "snap-back", keys: ["⌘", "⇧", "0"], label: "Snap the layout back", group: "Layout", wired: true },
  // W4: the rail's Talk — the conversation, voice first — open or put away.
  { id: "dock", keys: ["⌘", "J"], label: "Talk: open or put away the conversation", group: "Global", wired: true },
  // The way back to a blocked agent from anywhere — including from inside a
  // terminal, so App matches it in the capture phase, ahead of xterm.
  { id: "needs-you", keys: ["⌘", "⇧", "J"], label: "Jump to the terminal that needs you", group: "Global", wired: true },
  // Not a chord: a modifier held on its own (audio/voiceHotkey.ts, which owns
  // its listener). Double-tap locks the mic open; Voice settings changes it,
  // and the renderings name the key it chose (`shownKeymap`). One cap for the
  // key: the cheat sheet splits caps at plain spaces.
  { id: "dictate", keys: ["hold", "right\u00a0⌥"], label: "Dictate into the text box, or talk to the plan", group: "Global", wired: false },
  { id: "pane-sidebar", keys: ["⇧", "←"], label: "Show / hide the sidebar (as ⌘B)", group: "Layout", wired: false },
  { id: "pane-discussion", keys: ["⇧", "→"], label: "Show / hide the rail (as ⌘⌥B)", group: "Layout", wired: false },
  { id: "zoom-in", keys: ["⌘", "+"], label: "Zoom the document in", group: "Document", wired: false },
  { id: "zoom-out", keys: ["⌘", "−"], label: "Zoom the document out", group: "Document", wired: false },
  { id: "zoom-reset", keys: ["⌘", "0"], label: "Reset the zoom", group: "Document", wired: false },
];

// ---- The workbench's shortcuts (W1) -------------------------------------------
// Per-session tabs with a door tab: the chords every tabbed desktop app has.
// All native menu items (workbench_menu.rs) except the ⌘⌥←→ cycle aliases,
// which the window listener matches and browser_signals.js forwards from a
// page. ⌘W closes from the inside out — browser page → pane → tab — and never
// the window; that is ⌘⇧W.

export const WORKBENCH_KEYMAP: KeyBinding[] = [
  { id: "new-tab", keys: ["⌘", "T"], label: "New tab", group: "Global", wired: true },
  { id: "reopen-tab", keys: ["⌘", "⇧", "T"], label: "Reopen the last closed tab", group: "Global", wired: true },
  { id: "close", keys: ["⌘", "W"], label: "Close the page, pane or tab", group: "Global", wired: true },
  { id: "close-window", keys: ["⌘", "⇧", "W"], label: "Close the window", group: "Global", wired: true },
  { id: "tab-n", keys: ["⌘", "1–9"], label: "Tab 1–8, 9 = last", group: "Layout", wired: true },
  { id: "tab-cycle", keys: ["⌘", "⌥", "←/→"], label: "Previous / next tab", group: "Layout", wired: true },
  // W4: the two side columns. ⌘B is left to rich text, where it is bold.
  { id: "sidebar", keys: ["⌘", "B"], label: "Show / hide the sidebar", group: "Layout", wired: true },
  { id: "rail", keys: ["⌘", "⌥", "B"], label: "Show / hide the rail", group: "Layout", wired: true },
  // ⌘P is Go to File (a native menu item); Print moved to ⌘⌥P.
  { id: "quick-open", keys: ["⌘", "P"], label: "Go to a file", group: "Global", wired: true },
  // Inside a wall ⌘D is a new tile; elsewhere ⌘D / ⌘⇧D split the focused
  // pane right / down with a door. Never over an editor's own ⌘D
  // (CodeMirror's next occurrence prevents the default first).
  { id: "split", keys: ["⌘", "D"], label: "Split right with a new tab's door (in a wall: a new tile)", group: "Layout", wired: true },
  { id: "split-down", keys: ["⌘", "⇧", "D"], label: "Split down with a new tab's door", group: "Layout", wired: true },
  { id: "zoom-pane", keys: ["⌘", "⇧", "↩"], label: "Zoom the focused tile, or put it back", group: "Layout", wired: true },
];

/** The classic shell's registry with the workbench's chords folded in: the
 *  workbench globals right after the palette, its layout rows at the top of
 *  Layout, and the rest of the classic registry in its own order. */
export const CLASSIC_KEYMAP: KeyBinding[] = [
  GLOBAL_KEYMAP[0],
  ...WORKBENCH_KEYMAP.filter((b) => b.group === "Global"),
  ...GLOBAL_KEYMAP.slice(1).filter((b) => b.group === "Global"),
  ...WORKBENCH_KEYMAP.filter((b) => b.group === "Layout"),
  ...GLOBAL_KEYMAP.filter((b) => b.group !== "Global"),
];

/** The app's registry: the classic registry with the workbench's chords. */
export function shellKeymap(): KeyBinding[] {
  return CLASSIC_KEYMAP;
}

/** Hint keycaps for a binding id — the palette's hint column. */
export function bindingKeys(id: string): string[] | undefined {
  return shellKeymap().find((b) => b.id === id)?.keys;
}

// ---- With a web page focused --------------------------------------------------
// An embedded page has the keyboard to itself: no listener of the app's own
// document hears it. A chord reaches the app from there one of two ways —
// a native menu item, whose key equivalent fires whatever has focus
// (src-tauri workbench_menu.rs, and lib.rs's Close), or the page's own
// script forwarding it as a `shortcut` signal (src-tauri browser_signals.js,
// allowed by browser_events.rs, re-raised by BrowserPane as a window event).
// The plan marks the menu rows; every other wired chord is forwarded.
// `keymap.test.ts` walks this table against those three files.

export type PageRoute = { menu: string } | { signal: string };

/** How each wired binding reaches the app while a web page has focus. */
export const PAGE_ROUTES: Readonly<Record<string, readonly PageRoute[]>> = {
  palette: [{ signal: "palette" }],
  "front-door": [{ signal: "open-front-door" }],
  "new-plan": [{ signal: "new-plan" }],
  "snap-back": [{ signal: "snap-back" }],
  dock: [{ signal: "toggle-monochat" }],
  "needs-you": [{ signal: "needs-you" }],
  "new-tab": [{ menu: "wb_new_tab" }],
  "reopen-tab": [{ menu: "wb_reopen_tab" }],
  close: [{ menu: "close_tab" }],
  "close-window": [{ menu: "wb_close_window" }],
  "tab-n": [{ menu: "wb_tab_1" }, { menu: "wb_last_tab" }],
  // ⌘⇧[ / ⌘⇧] are menu items; ⌘⌥← / ⌘⌥→ (a menu item carries one key) are
  // forwarded.
  "tab-cycle": [{ menu: "wb_prev_tab" }, { menu: "wb_next_tab" }, { signal: "previous-tab" }, { signal: "next-tab" }],
  "quick-open": [{ menu: "wb_go_to_file" }],
  // The page keeps ⌘B (bold in a web editor); forwarded only outside a field.
  sidebar: [{ signal: "toggle-sidebar" }],
  rail: [{ signal: "toggle-plan-panel" }],
};

/** Not the app's chords but the browser's own, forwarded from a page all
 *  the same: ⌃Tab / ⌃⇧Tab cycle its pages. */
export const PAGE_ONLY_SIGNALS: readonly string[] = ["next-page", "previous-page"];

/** Wired bindings a focused page keeps for itself: splits and the zoom act
 *  on the workbench's panes, which a page is not. */
export const PAGE_KEEPS: readonly string[] = ["split", "split-down", "zoom-pane"];

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

/** ⌘J — the rail's Talk (W4). Shift and Alt excluded: ⌘⇧J is the
 *  needs-you jump below. */
export function isDockKey(e: KeyComboInfo): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.shiftKey || e.altKey) return false;
  return e.key === "j" || e.key === "J";
}

/** ⌘⇧J — jump to the next terminal that needs you. `e.code` for the same
 *  reason as snap-back (Shift rewrites e.key), and Alt excluded so ⌥⌘⇧J
 *  stays free. */
export function isNeedsYouKey(e: KeyComboInfo): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.altKey) return false;
  return e.shiftKey && e.code === "KeyJ";
}

const commandOnly = (e: KeyComboInfo) => e.metaKey && !e.ctrlKey;

// ---- The workbench's matchers ----------------------------------------------------
// ⌘ only, never Ctrl, and on e.code: in a terminal Ctrl+T, Ctrl+W and Ctrl+[
// are the shell's (transpose, kill-word, Esc), and ⌥ and ⇧ rewrite e.key.
// Where a native menu item carries the same chord the menu fires first and
// the page never sees the keydown; these answer the same way when it didn't.

/** ⌘T — a new (door) tab. */
export function isNewTabKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && !e.shiftKey && !e.altKey && e.code === "KeyT";
}

/** ⌘⇧T — reopen the last closed tab. */
export function isReopenTabKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && e.shiftKey && !e.altKey && e.code === "KeyT";
}

/** ⌘W — close from the inside out: browser page → pane → tab. Never the
 *  window. */
export function isCloseKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && !e.shiftKey && !e.altKey && e.code === "KeyW";
}

/** ⌘⇧W — close the window (the close-confirm applies). */
export function isCloseWindowKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && e.shiftKey && !e.altKey && e.code === "KeyW";
}

/** ⌘1–⌘8 → the tab index 0..7; ⌘9 → −1, the last tab; null otherwise.
 *  Shift opts out (⌘⇧0 is the snap-back) and so does ⌥. */
export function tabIndexKeyOf(e: KeyComboInfo): number | null {
  if (!commandOnly(e) || e.shiftKey || e.altKey) return null;
  const m = /^Digit([1-9])$/.exec(e.code);
  if (!m) return null;
  const n = Number(m[1]);
  return n === 9 ? -1 : n - 1;
}

/** ⌘⌥← / ⌘⌥→ and ⌘⇧[ / ⌘⇧] → −1 / 1, the previous / next tab; null
 *  otherwise. Exactly those modifiers: plain ⌘← is the line start in a text
 *  field and ⌘⌥⇧← stays free. */
export function tabCycleKeyOf(e: KeyComboInfo): -1 | 1 | null {
  if (!commandOnly(e)) return null;
  if (e.altKey && !e.shiftKey) {
    if (e.code === "ArrowLeft") return -1;
    if (e.code === "ArrowRight") return 1;
    return null;
  }
  if (e.shiftKey && !e.altKey) {
    if (e.code === "BracketLeft") return -1;
    if (e.code === "BracketRight") return 1;
  }
  return null;
}

/** ⌘B — the left sidebar. ⌘ only, on the physical key; a rich-text target
 *  keeps it as bold (the caller checks the target). */
export function isSidebarToggleKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && !e.shiftKey && !e.altKey && e.code === "KeyB";
}

/** ⌘⌥B — the right rail. On e.code because ⌥ rewrites e.key ("b" → "∫"). */
export function isRailToggleKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && !e.shiftKey && e.altKey && e.code === "KeyB";
}

/** ⌘D → "row" (split right; in a wall, a new tile) and ⌘⇧D → "column"
 *  (split down); null otherwise. ⌘ only, on the physical key. The caller
 *  listens in the bubble phase and skips an event already `defaultPrevented`,
 *  so an editor keeps its own ⌘D. */
export function splitKeyOf(e: KeyComboInfo): "row" | "column" | null {
  if (!commandOnly(e) || e.altKey || e.code !== "KeyD") return null;
  return e.shiftKey ? "column" : "row";
}

/** ⌘⇧↩ — zoom the focused tile (or pane), or put it back. Matched in the
 *  capture phase: a terminal would otherwise take the Return. */
export function isZoomPaneKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && e.shiftKey && !e.altKey && (e.code === "Enter" || e.code === "NumpadEnter");
}

/** ⌘P — go to a file (quick open). ⌘⌥P is Print now. */
export function isQuickOpenKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && !e.shiftKey && !e.altKey && e.code === "KeyP";
}

/** Shift+Enter summons the front door without colliding with modified sends.
 *  The chord alone: callers leave it to a text field that has focus, where it
 *  is the newline (a composer, a web form, Claude Code's prompt). */
export function isFrontDoorKey(e: KeyComboInfo): boolean {
  return e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
}

// ---- Renderings -------------------------------------------------------------

/** The registry as this machine has it: the dictation entry names the hold
 *  key Voice settings chose, and is left out while that key is Off. */
export function shownKeymap(): KeyBinding[] {
  const cap = HOLD_KEYS.find((k) => k.key === loadHoldKey())?.cap;
  return shellKeymap().flatMap((b) => (b.id !== "dictate" ? [b] : cap ? [{ ...b, keys: ["hold", cap] }] : []));
}

/** The onboarding tour's shortcuts step, straight from the registry. */
export function tourShortcuts(): { keys: string[]; text: string }[] {
  return shownKeymap().map((b) => ({ keys: b.keys, text: b.label }));
}

/** ShortcutHelp-shaped groups for a global cheat sheet, registry-ordered.
 *  (`ShortcutHelp` splits `keys` on spaces into keycaps.) */
export function globalShortcutGroups(): ShortcutGroup[] {
  const order: KeyBinding["group"][] = ["Global", "Layout", "Document"];
  const shown = shownKeymap();
  return order.map((title) => ({
    title,
    items: shown.filter((b) => b.group === title).map((b) => ({
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
