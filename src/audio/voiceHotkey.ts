// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The hold-to-dictate key: hold Right ⌥ (configurable) anywhere in Redline and
// speak; let go and the words land where the cursor is. A pure state machine
// (`stepHotkey`) plus the thin wiring that feeds it key events.
//
// The key is a modifier, and on many keyboard layouts Right ⌥ is AltGr — the
// key that types "@", "€" or "[". So it reacts only to a SOLO hold: a press
// with no other modifier down that is held `HOLD_MS` with no other key pressed
// starts a capture, and any other key during the hold cancels it and goes on
// to the page untouched. The machine never prevents a default except for the
// Esc that cancels a capture it started.
//
// - Hold ≥ `HOLD_MS`, release: dictate (push-to-talk).
// - Tap, then press again within `DOUBLE_TAP_MS`: lock the mic open; the next
//   tap ends it.
// - Esc while capturing: cancel, nothing written.
// - While a finished capture is being transcribed and placed (`busy`), the key
//   is ignored; a key-repeat never starts anything.
//
// Where the key is heard: Redline's own window hears it as DOM key events. A
// web page in the browser pane is a native child webview with keyboard focus
// of its own, so the main window hears nothing while a page is focused; the
// page script every tab carries (browser_frontdoor_shortcut.js, every frame)
// forwards the same key's presses as `voice` page signals instead, saying
// whether the page's focused element takes text. That bridge was chosen over a
// native app-wide key monitor because it already exists, costs no binary and
// needs no permission; a page whose scripts don't run (a PDF) doesn't hear the
// key — click into Redline's own chrome first.

export const HOLD_MS = 250;
/** A tap and a press closer together than this lock the mic open. */
export const DOUBLE_TAP_MS = 300;

export type HoldKey = "AltRight" | "MetaRight" | "ControlRight" | "off";
export const DEFAULT_HOLD_KEY: HoldKey = "AltRight";
export const HOLD_KEYS: { key: HoldKey; label: string }[] = [
  { key: "AltRight", label: "Right ⌥ Option" },
  { key: "MetaRight", label: "Right ⌘ Command" },
  { key: "ControlRight", label: "Right ⌃ Control" },
  { key: "off", label: "Off" },
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

/** Where a key event came from: Redline's own window, or the web page in the
 *  browser tab `page` (its webview label), whose focused element may be a
 *  text field. */
export type KeySource = { page: null } | { page: string; field: boolean };
export const APP_KEYS: KeySource = { page: null };

export type HotkeyPhase =
  /** Nothing pressed. */
  | "idle"
  /** Pressed alone; a capture starts if it stays alone for `HOLD_MS`. */
  | "pending"
  /** Capturing while the key is held. */
  | "holding"
  /** Capturing with the key up: the mic was locked open. */
  | "locked"
  /** This press is over (another key joined it): wait for the release. */
  | "spent"
  /** A finished capture is being transcribed and placed. */
  | "busy";

export interface HotkeyState {
  phase: HotkeyPhase;
  /** When the press (or the lock) began. */
  since: number;
  source: KeySource;
  /** When the last lone tap ended. */
  tapAt: number | null;
  /** Locked, and the key is down again: its release ends the lock. */
  ending: boolean;
}

export const HOTKEY_IDLE: HotkeyState = { phase: "idle", since: 0, source: APP_KEYS, tapAt: null, ending: false };

export type HotkeyEvent =
  /** The hold key went down; `solo` when no other modifier was down. */
  | { type: "down"; at: number; source: KeySource; solo: boolean }
  | { type: "up"; at: number }
  /** Any other key went down. */
  | { type: "other"; at: number }
  | { type: "escape"; at: number }
  /** `HOLD_MS` passed since a pending press. */
  | { type: "elapsed"; at: number }
  /** The window lost focus: a key held now is released somewhere else. */
  | { type: "blur"; at: number }
  /** A capture started some other way (a composer's mic button): the key's
   *  tap ends it and Esc cancels it, as for a lock. */
  | { type: "locked"; at: number }
  /** The capture is over: placed, sent, cancelled, taken or failed. */
  | { type: "settled" };

export type HotkeyEffect =
  | { type: "start"; mode: "hold" | "lock"; since: number; source: KeySource }
  | { type: "finish" }
  | { type: "cancel" };

export interface HotkeyStep {
  state: HotkeyState;
  effect: HotkeyEffect | null;
  /** Keep the event from the page (only the Esc that cancels a capture). */
  swallow: boolean;
}

const stay = (state: HotkeyState): HotkeyStep => ({ state, effect: null, swallow: false });

export function stepHotkey(s: HotkeyState, e: HotkeyEvent): HotkeyStep {
  const to = (patch: Partial<HotkeyState>, effect: HotkeyEffect | null = null, swallow = false): HotkeyStep => ({
    state: { ...s, ...patch },
    effect,
    swallow,
  });
  if (e.type === "settled") {
    // Still held: this press is spent until it comes up.
    const held = s.phase === "holding" || (s.phase === "locked" && s.ending);
    return to({ phase: held ? "spent" : "idle", ending: false, tapAt: null });
  }
  switch (s.phase) {
    case "idle":
      if (e.type === "down") {
        if (!e.solo) return to({ phase: "spent", tapAt: null });
        if (s.tapAt !== null && e.at - s.tapAt <= DOUBLE_TAP_MS) {
          // The second press of a double tap: its own release is not the tap
          // that ends the lock.
          return to(
            { phase: "locked", since: e.at, source: e.source, tapAt: null, ending: false },
            { type: "start", mode: "lock", since: e.at, source: e.source },
          );
        }
        return to({ phase: "pending", since: e.at, source: e.source, tapAt: null });
      }
      if (e.type === "locked") return to({ phase: "locked", since: e.at, source: APP_KEYS, tapAt: null, ending: false });
      // Every keystroke in the app passes here: no new state for nothing.
      if ((e.type === "other" || e.type === "escape") && s.tapAt !== null) return to({ tapAt: null });
      return stay(s);
    case "pending":
      if (e.type === "elapsed" && e.at - s.since >= HOLD_MS) {
        return to({ phase: "holding" }, { type: "start", mode: "hold", since: s.since, source: s.source });
      }
      // A lone tap: maybe the first of two.
      if (e.type === "up") return to({ phase: "idle", tapAt: e.at });
      if (e.type === "other" || e.type === "escape") return to({ phase: "spent" });
      if (e.type === "blur") return to({ phase: "idle" });
      return stay(s);
    case "holding":
      if (e.type === "up" || e.type === "blur") return to({ phase: "busy" }, { type: "finish" });
      // A character typed with the key as AltGr: never a dictation.
      if (e.type === "other") return to({ phase: "spent" }, { type: "cancel" });
      if (e.type === "escape") return to({ phase: "spent" }, { type: "cancel" }, true);
      return stay(s);
    case "locked":
      if (e.type === "escape") return to({ phase: s.ending ? "spent" : "idle", ending: false }, { type: "cancel" }, true);
      if (e.type === "down") return e.solo ? to({ ending: true }) : stay(s);
      if (e.type === "up") return s.ending ? to({ phase: "busy", ending: false }, { type: "finish" }) : stay(s);
      // Typing while the mic is open is fine; the key as AltGr is not a tap.
      if (e.type === "other") return to({ ending: false });
      return stay(s);
    case "spent":
      if (e.type === "up" || e.type === "blur") return to({ phase: "idle", tapAt: null });
      return stay(s);
    case "busy":
      return stay(s);
  }
}

/** Whether the hold key went down alone: no other modifier held with it. */
export function soloPress(e: Pick<KeyboardEvent, "altKey" | "metaKey" | "ctrlKey" | "shiftKey" | "isComposing">, key: HoldKey): boolean {
  if (e.isComposing || e.shiftKey) return false;
  return (key === "AltRight" || !e.altKey) && (key === "MetaRight" || !e.metaKey) && (key === "ControlRight" || !e.ctrlKey);
}

/** What the key's machine does in the world. */
export interface HotkeyHooks {
  start(mode: "hold" | "lock", since: number, source: KeySource): void;
  finish(): void;
  cancel(): void;
}

/** The machine, its hold timer, and the window and page events that feed it. */
export class VoiceHotkey {
  state: HotkeyState = HOTKEY_IDLE;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly hooks: HotkeyHooks,
    private readonly key: () => HoldKey = loadHoldKey,
    private readonly now: () => number = Date.now,
  ) {}

  /** Feed one event; true when its key event must not reach the page. */
  dispatch(e: HotkeyEvent): boolean {
    const step = stepHotkey(this.state, e);
    this.state = step.state;
    if (this.timer && step.state.phase !== "pending") {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (step.state.phase === "pending" && !this.timer) {
      const since = step.state.since;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.dispatch({ type: "elapsed", at: Math.max(this.now(), since + HOLD_MS) });
      }, HOLD_MS);
    }
    const effect = step.effect;
    if (effect?.type === "start") this.hooks.start(effect.mode, effect.since, effect.source);
    else if (effect?.type === "finish") this.hooks.finish();
    else if (effect?.type === "cancel") this.hooks.cancel();
    return step.swallow;
  }

  /** Listen on Redline's own window. Capture phase, ahead of every handler. */
  attach(win: Window): () => void {
    const down = (e: KeyboardEvent) => {
      const key = this.key();
      if (key !== "off" && e.code === key) {
        if (!e.repeat) this.dispatch({ type: "down", at: this.now(), source: APP_KEYS, solo: soloPress(e, key) });
        return;
      }
      if (this.dispatch({ type: e.key === "Escape" ? "escape" : "other", at: this.now() })) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === this.key()) this.dispatch({ type: "up", at: this.now() });
    };
    const blur = () => this.dispatch({ type: "blur", at: this.now() });
    win.addEventListener("keydown", down, true);
    win.addEventListener("keyup", up, true);
    win.addEventListener("blur", blur);
    return () => {
      win.removeEventListener("keydown", down, true);
      win.removeEventListener("keyup", up, true);
      win.removeEventListener("blur", blur);
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    };
  }

  /** A key a web page forwarded (`voice` page signals): `down:<code>` or
   *  `field:<code>` (the page's focus takes text), `up`, `other`, `escape`. */
  page(label: string, value: string): void {
    const at = this.now();
    const [kind, code] = value.split(":");
    if (kind === "down" || kind === "field") {
      const key = this.key();
      if (key !== "off" && code === key) this.dispatch({ type: "down", at, source: { page: label, field: kind === "field" }, solo: true });
      else this.dispatch({ type: "other", at });
    } else if (kind === "up") this.dispatch({ type: "up", at });
    else if (kind === "escape") this.dispatch({ type: "escape", at });
    else if (kind === "other") this.dispatch({ type: "other", at });
  }
}
