// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Which key is held to dictate (voiceHotkey.ts listens for it): the setting
// on its own, so the shortcut registry (lib/keymap.ts) can name the key Voice
// settings chose without loading the dictation code.

export type HoldKey = "AltRight" | "MetaRight" | "ControlRight" | "off";
export const DEFAULT_HOLD_KEY: HoldKey = "AltRight";
/** Each choice: its name in Voice settings, and its keycap in the shortcut
 *  list — one cap, so a no-break space (the cheat sheet splits caps at plain
 *  spaces); none for Off. */
export const HOLD_KEYS: { key: HoldKey; label: string; cap: string | null }[] = [
  { key: "AltRight", label: "Right ⌥ Option", cap: "right ⌥" },
  { key: "MetaRight", label: "Right ⌘ Command", cap: "right ⌘" },
  { key: "ControlRight", label: "Right ⌃ Control", cap: "right ⌃" },
  { key: "off", label: "Off", cap: null },
];

const KEY_PREF = "redline.dictation.key";
let holdKey: HoldKey | null = null;

/** The configured key (per machine, like the voice prefs). */
export function loadHoldKey(): HoldKey {
  if (holdKey) return holdKey;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY_PREF);
  } catch {
    /* private mode: the default */
  }
  holdKey = HOLD_KEYS.some((k) => k.key === saved) ? (saved as HoldKey) : DEFAULT_HOLD_KEY;
  return holdKey;
}

export function saveHoldKey(key: HoldKey): void {
  holdKey = key;
  try {
    localStorage.setItem(KEY_PREF, key);
  } catch {
    /* best-effort, like the voice prefs */
  }
}
