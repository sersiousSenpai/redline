// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { DocumentPlateMode } from "./documentPlate";
import { isEditableTarget } from "./landing";
import type { MainSurface } from "./mainSurface";

/** What a plan arriving from a session does to the reader.
 *
 *  - `focus`: select it. On the document surface that brings it on screen
 *    (from the Front Door the plate turns into the plan); on a masked surface
 *    (browser, memory, runs) it becomes what you come back to, and the
 *    surface itself is left alone — the caller offers a Review instead.
 *  - `flash`: you are in the middle of something else — writing, reading
 *    another plan or a file, or looking back at an older version of this
 *    one. Nothing moves: the arrival marks its sidebar row, badges the pill
 *    and says so in a brief notice with Open.
 *  - `handoff`: it is the plan you launched with ⏎ from the door you are
 *    still in, and you have begun nothing new there since. That ⏎ was the
 *    gesture and this is what it asked for: the door hands off into the plan.
 *
 *  One rule replaces the old special cases. "A live dock conversation on
 *  another plan" was only ever a way of reading another plan. */
export type ArrivalFocus = "focus" | "flash" | "handoff";

export interface ArrivalState {
  /** The session on screen, or null. */
  activeId: string | null;
  /** The session the plan belongs to. */
  sessionId: string;
  mainSurface: MainSurface;
  plateMode: DocumentPlateMode;
  /** The version the reader chose to look back at; null is the latest. */
  viewedVersion?: number | null;
  /** The user is writing (see `writingNow`). */
  writing?: boolean;
  /** It is the user's own launch from the door they are still in
   *  (`ownDoorLaunch`). */
  ownDoorLaunch?: boolean;
}

export function arrivalFocus(state: ArrivalState): ArrivalFocus {
  if (state.ownDoorLaunch) return "handoff";
  const onPlate = state.mainSurface === "document";
  if (onPlate && state.plateMode === "file") return "flash";
  // A new version of the plan already selected is the answer waited for: it
  // lands in place, even mid-sentence — the caret stays put either way —
  // unless the reader chose to be on an older version.
  if (state.activeId === state.sessionId) {
    return onPlate && state.plateMode === "plan" && state.viewedVersion != null ? "flash" : "focus";
  }
  if (state.writing) return "flash";
  return onPlate && state.plateMode === "plan" ? "flash" : "focus";
}

/** The open door, as an arriving plan finds it. */
export interface DoorAtArrival {
  open: boolean;
  /** The launch the door is showing in place: set by ⏎ in the open door,
   *  cleared when the door closes or takes up a chat. */
  showing: string | null;
  /** What is in its composer now. */
  draft: string;
  attachments: number;
  /** When a key was last typed into a text field (`isWritingKey`). */
  typedAt: number;
}

/** Whether a plan arriving as `launchId` is the user's own launch from the
 *  door, which is still open on it with nothing new begun: no sentence or
 *  attachment put in the composer since, and no key typed there in the last
 *  WRITING_MS — someone who typed and cleared a sentence, or is mid-word in
 *  an input method, is still composing. A new draft keeps the door, and the
 *  plan flashes like any other. */
export function ownDoorLaunch(door: DoorAtArrival, launchId: string | null | undefined, now: number): boolean {
  return door.open && !!launchId && door.showing === launchId && !door.draft.trim() && door.attachments === 0 && now - door.typedAt >= WRITING_MS;
}

/** How long a keystroke keeps someone writing, as far as an arrival goes. */
export const WRITING_MS = 5000;

/** The island's two poses: the door's layer and the compact card. */
const ISLAND = ".rl-frontdoor-focus, .rl-monochat-float";

/** A keystroke that counts as writing: into a text field, never the
 *  terminal — its caret is the shell's, and waiting at a prompt for the
 *  plan is exactly when the plan should come on screen. */
export function isWritingKey(target: EventTarget | null): boolean {
  return target instanceof Element && isEditableTarget(target as HTMLElement) && !target.closest(".xterm");
}

/** Whether the user is writing when a plan arrives: the caret is in the
 *  island (the door or the compact card), or in a text field holding words,
 *  or they typed into one in the last WRITING_MS. */
export function writingNow(active: Element | null, typedAt: number, now: number): boolean {
  if (now - typedAt < WRITING_MS) return true;
  if (!active || active.closest(".xterm")) return false;
  if (active.closest(ISLAND)) return true;
  if (!isEditableTarget(active as HTMLElement)) return false;
  const words = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.value : active.textContent;
  return !!words?.trim();
}

/** The arrival notice's copy. "Intercepted" described the mechanism, not the
 *  news — the news is that a plan is here, or a new version of the one you
 *  are reading. */
export function arrivalMessage(title: string | null | undefined, revision = false): string {
  const t = title?.trim(), news = revision ? "New version" : "New plan";
  return t ? `${news} · ${t}` : news;
}
