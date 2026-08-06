// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The landing's type-to-start handoff (A4). The empty document plate shows a
// live first page ("Draft a new plan" behind a blinking caret), and typing
// anywhere on it carries the keystrokes into a fresh Drafter document. From
// the first printable key until the Drafter's editor takes focus, keydowns
// buffer through this machine; the drafter consumes the buffer atomically
// with its mount focus (same task — no keydown can interleave), so the
// handoff is lossless. Pure in the style of lib/boot.ts: classification and
// the phase step live here, the window listener and refs in App.tsx.

export type LandingPhase = "idle" | "handoff";

export type SeedAction = "ignore" | "start" | "buffer" | "erase" | "release";

export interface SeedKeyInfo {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/** A keystroke that should become document text: one printable character,
 *  no command modifiers, not part of an IME composition. Shift is fine —
 *  it's how capitals arrive; named keys ("Enter", "ArrowLeft", "F5") have
 *  multi-char `key`s and fall out naturally. */
export function isSeedKey(e: SeedKeyInfo): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.isComposing) return false;
  return e.key.length === 1;
}

/** True when the keystroke already belongs to a focused editing surface —
 *  an input, textarea, select, or contenteditable. xterm types through a
 *  hidden textarea and TipTap/CodeMirror are contenteditable, so this is
 *  what keeps terminal keystrokes (the "run `claude`" path the landing sits
 *  above) from being hijacked into a draft. */
export function isEditableTarget(
  t: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!t) return false;
  const tag = (t.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!t.isContentEditable;
}

/** One keydown through the handoff machine. "start" begins the handoff with
 *  this key; "buffer"/"erase" grow and trim the seed mid-flight; "release"
 *  ends a handoff whose editor now owns input (belt-and-braces — the
 *  drafter's seed consumption normally resets the phase first). */
export function seedStep(
  phase: LandingPhase,
  k: { printable: boolean; erase: boolean; editable: boolean },
): SeedAction {
  if (phase === "idle") {
    return k.printable && !k.editable ? "start" : "ignore";
  }
  if (k.editable) return "release";
  if (k.printable) return "buffer";
  if (k.erase) return "erase";
  return "ignore";
}

/** Apply an action to the seed buffer. */
export function applySeed(
  buffer: string,
  action: SeedAction,
  key: string,
): string {
  switch (action) {
    case "start":
      return key;
    case "buffer":
      return buffer + key;
    case "erase":
      return buffer.slice(0, -1);
    case "release":
      return "";
    default:
      return buffer;
  }
}
