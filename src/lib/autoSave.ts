// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The file pane's auto-save (W7): the setting, the policy and the timer, kept
// out of CodeEditor's React component so each is a unit — the editor wires
// them to CodeMirror, the disk watcher and the changed-on-disk banner.
//
// The one rule the policy exists for: an auto-save never writes over a file
// that moved on disk. The banner showing, a Compare open, or a disk change
// the user has seen and not yet answered with a deliberate save (Keep
// editing leaves the buffer diverged) all pause it; only ⌘S / Save /
// Overwrite write then. The editor also re-reads the disk right before every
// auto-save, so a change the watcher has not reported yet raises the banner
// instead of being overwritten.

import { useCallback, useEffect } from "react";

import { usePersistedState } from "../theme/usePersistedState";

/** Off: ⌘S only. Delay: a second after the last keystroke, and on leaving the
 *  editor with edits pending. Focus: on leaving the editor only (blur, a tab
 *  or file switch, the window losing focus). */
export type AutoSaveMode = "off" | "delay" | "focus";

export const AUTO_SAVE_MODES: { mode: AutoSaveMode; label: string }[] = [
  { mode: "off", label: "Off" },
  { mode: "delay", label: "After delay" },
  { mode: "focus", label: "On focus change" },
];

export const AUTO_SAVE_KEY = "redline.autoSave";
/** After delay, the convention of Claude Code Desktop and most editors; the
 *  Drafter's own autosave runs at 400 ms, a file waits a little longer. */
export const AUTO_SAVE_DEFAULT: AutoSaveMode = "delay";
export const AUTO_SAVE_DELAY_MS = 1000;
/** `save_text_file`'s guard (the same 2 MB cap as `read_text_file`): a buffer
 *  past it falls back to manual save, whose error says why. */
export const AUTO_SAVE_MAX_BYTES = 2 * 1024 * 1024;

const MODE_EVENT = "redline:auto-save-mode";

function isMode(v: unknown): v is AutoSaveMode {
  return v === "off" || v === "delay" || v === "focus";
}

/** The persisted setting, kept in step across every reader (the Settings row
 *  and each open editor) through one window event. */
export function useAutoSaveMode(): [AutoSaveMode, (next: AutoSaveMode) => void] {
  const [stored, setStored] = usePersistedState<AutoSaveMode>(AUTO_SAVE_KEY, AUTO_SAVE_DEFAULT);
  useEffect(() => {
    const on = (e: Event) => {
      const next = (e as CustomEvent<unknown>).detail;
      if (isMode(next)) setStored(next);
    };
    window.addEventListener(MODE_EVENT, on);
    return () => window.removeEventListener(MODE_EVENT, on);
  }, [setStored]);
  const set = useCallback((next: AutoSaveMode) => {
    setStored(next);
    window.dispatchEvent(new CustomEvent(MODE_EVENT, { detail: next }));
  }, [setStored]);
  return [isMode(stored) ? stored : AUTO_SAVE_DEFAULT, set];
}

/** What asked for the save: the debounce elapsing, or the editor being left. */
export type AutoSaveTrigger = "delay" | "leave";

export interface AutoSaveState {
  mode: AutoSaveMode;
  trigger: AutoSaveTrigger;
  dirty: boolean;
  /** A write already in flight. */
  saving: boolean;
  /** The changed-on-disk banner is showing. */
  conflict: boolean;
  /** A Compare is open. */
  comparing: boolean;
  /** The disk moved under this buffer and no deliberate save has answered it
   *  (Keep editing clears the banner, not this). */
  diverged: boolean;
  /** The buffer's size in UTF-8 bytes (`utf8Bytes`). */
  bytes: number;
}

/** Should this trigger write the buffer now? */
export function shouldAutoSave(s: AutoSaveState): boolean {
  if (s.mode === "off") return false;
  if (s.trigger === "delay" && s.mode !== "delay") return false;
  if (!s.dirty || s.saving) return false;
  if (s.conflict || s.comparing || s.diverged) return false;
  return s.bytes <= AUTO_SAVE_MAX_BYTES;
}

/** UTF-8 length, without encoding when the answer is already under the cap. */
export function utf8Bytes(s: string): number {
  if (s.length * 3 <= AUTO_SAVE_MAX_BYTES) return s.length;
  return new TextEncoder().encode(s).length;
}

/** The trailing debounce: `edited()` on every buffer change re-arms it,
 *  `left()` flushes a pending one at once (Delay) or fires the leave save
 *  (Focus), `cancel()` drops it. `fire` runs the policy, so a timer that lands
 *  on a paused editor writes nothing. */
export function createAutoSaveTimer(opts: {
  delayMs: number;
  fire: (trigger: AutoSaveTrigger) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  return {
    edited() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        opts.fire("delay");
      }, opts.delayMs);
    },
    left() {
      cancel();
      opts.fire("leave");
    },
    cancel,
    pending: () => timer != null,
  };
}
