// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The app's keyboard shortcuts as data (A5). One declarative registry feeds
// every place a shortcut is *shown* — the command palette's hint column, the
// ShortcutHelp cheat sheets, the onboarding tour's shortcuts step — so a
// binding can't drift between the surfaces that describe it.
//
// Honest scope: only the wired globals (⌘K palette, ⌘⇧N new plan, ⇧⏎ front
// door, ⌘⇧0 snap-back, ⌘J front-door toggle, ⌘⇧J needs-you jump, and the flow
// shell's own — FLOW_KEYMAP) use the matchers below; every other entry
// documents an existing listener that still owns its own keydown handling
// (`wired: false`).
// Rewiring those long-proven listeners through a generic dispatcher would be
// churn without benefit — the registry's job is a single source of truth for
// what exists, not a new event system.

import { HOLD_KEYS, loadHoldKey } from "../audio/holdKey";
import { shellFlag, type Shell } from "./shellFlag";

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
  // The existing alternate toggle for the front door.
  { id: "dock", keys: ["⌘", "J"], label: "Show / hide the front door", group: "Global", wired: true },
  // The way back to a blocked agent from anywhere — including from inside a
  // terminal, so App matches it in the capture phase, ahead of xterm.
  { id: "needs-you", keys: ["⌘", "⇧", "J"], label: "Jump to the terminal that needs you", group: "Global", wired: true },
  // Not a chord: a modifier held on its own (audio/voiceHotkey.ts, which owns
  // its listener). Double-tap locks the mic open; Voice settings changes it,
  // and the renderings name the key it chose (`shownKeymap`). One cap for the
  // key: the cheat sheet splits caps at plain spaces.
  { id: "dictate", keys: ["hold", "right\u00a0⌥"], label: "Dictate into the text box, or talk to the plan", group: "Global", wired: false },
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

// ---- The flow shell's shortcuts (deviation 5) ---------------------------------
// The session-first shell takes the chords people already know from other
// desktop agents: ⌘N a new session, ⌘B the sidebar, ⌘J the conversation or
// the terminal, ⌘⌥B the plan, ⌘1–⌘4 the Tools. ⌘N and ⌘1–4 are native menu
// accelerators (lib.rs `flow_menu`), so they work while a browser page has
// focus; ⌘B, ⌘⌥B and ⌘J are App's listeners, forwarded from the browser by
// browser_signals.js. ⌘⇧N still opens the start screen for one release, but
// is no longer shown anywhere.

const FLOW_ONLY: KeyBinding[] = [
  { id: "new-session", keys: ["⌘", "N"], label: "New session", group: "Global", wired: true },
  { id: "stage", keys: ["⌘", "J"], label: "Switch between the conversation and the terminal", group: "Global", wired: true },
  { id: "tools", keys: ["⌘", "1–4"], label: "Browser, Prompt drafter, Code review, Localhost", group: "Global", wired: true },
  { id: "sidebar", keys: ["⌘", "B"], label: "Show / hide the sidebar", group: "Layout", wired: true },
  { id: "plan-panel", keys: ["⌘", "⌥", "B"], label: "Show / hide the plan", group: "Layout", wired: true },
];

/** Classic bindings the flow shell replaces: the door toggle (⌘J is the
 *  stage's now), the old new-plan chord (an unadvertised alias), and ⇧← for
 *  a sidebar that ⌘B owns. */
const FLOW_REPLACES = new Set(["dock", "new-plan", "pane-sidebar"]);

/** The flow shell's registry, in reading order: the new globals lead, the
 *  rest of the classic registry follows minus what they replace. */
export const FLOW_KEYMAP: KeyBinding[] = [
  GLOBAL_KEYMAP[0],
  ...FLOW_ONLY.filter((b) => b.group === "Global"),
  ...GLOBAL_KEYMAP.slice(1).filter((b) => !FLOW_REPLACES.has(b.id) && b.group === "Global"),
  ...FLOW_ONLY.filter((b) => b.group === "Layout"),
  ...GLOBAL_KEYMAP.filter((b) => !FLOW_REPLACES.has(b.id) && b.group !== "Global"),
];

/** The registry of the shell this page paints. */
export function shellKeymap(shell: Shell = shellFlag()): KeyBinding[] {
  return shell === "flow" ? FLOW_KEYMAP : GLOBAL_KEYMAP;
}

/** Hint keycaps for a binding id — the palette's hint column. Only the
 *  painted shell's bindings answer, so a hint never names a chord that
 *  shell does not have. */
export function bindingKeys(id: string, shell: Shell = shellFlag()): string[] | undefined {
  return shellKeymap(shell).find((b) => b.id === id)?.keys;
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

/** ⌘J — toggle the front door. Shift and Alt excluded: ⌘⇧J is the
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

// ---- The flow shell's matchers ------------------------------------------------
// ⌘ only, never Ctrl: ⌘J and ⌘B run in the capture phase, ahead of xterm, and
// in a terminal Ctrl+J is a newline and Ctrl+B is readline's back-a-char and
// tmux's prefix. Taking either would break the shell under the user's hands.

const commandOnly = (e: KeyComboInfo) => e.metaKey && !e.ctrlKey;

/** ⌘J in the flow shell — the stage's Conversation | Terminal. */
export function isStageKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && !e.shiftKey && !e.altKey && (e.key === "j" || e.key === "J");
}

/** ⌘B — the flow sidebar. */
export function isSidebarKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && !e.shiftKey && !e.altKey && (e.key === "b" || e.key === "B");
}

/** ⌘⌥B — the plan panel. On e.code: ⌥ rewrites e.key ("b" → "∫") on a Mac. */
export function isPlanPanelKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && e.altKey && !e.shiftKey && e.code === "KeyB";
}

/** ⌘N — a new session. The native menu item normally takes it first; this
 *  is the same chord for a page that has no native menu (and for a menu
 *  that failed to install). */
export function isNewSessionKey(e: KeyComboInfo): boolean {
  return commandOnly(e) && !e.shiftKey && !e.altKey && (e.key === "n" || e.key === "N");
}

/** ⌘1–⌘4 — which Tools row, or null. The native menu's accelerators normally
 *  take these first, as with ⌘N. */
export function toolKeyOf(e: KeyComboInfo): 1 | 2 | 3 | 4 | null {
  if (!commandOnly(e) || e.shiftKey || e.altKey) return null;
  const n = Number(e.key);
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
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
