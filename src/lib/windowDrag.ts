// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Programmatic window-drag, extracted from Header so the immersive hull rail
// can carry the identical behavior. `tauri.conf.json` sets
// `titleBarStyle: "Overlay"` + `hiddenTitle: true`: there is no native title
// bar, the macOS traffic lights float over the content, and whatever sits at
// the top of the window IS the drag region. Tauri 2's data-tauri-drag-region
// attribute does not reliably walk ancestors in this build — only exact
// mousedown targets were dragging, leaving the header mostly inert — so we
// listen on the bar itself and trigger startDragging() unless the mousedown
// originated on an interactive control. Double-click invokes the platform's
// title-bar action (zoom on macOS).

import { getCurrentWindow } from "@tauri-apps/api/window";

const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"]);

/** Did this event land on a control rather than on bare bar? Walks up to the
 *  enclosing <header> and stops there — the bar element itself is draggable,
 *  anything above it in the tree is not this bar's business. */
export function isInteractive(target: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (el.dataset?.noDrag === "true") return true;
    if (el.tagName === "HEADER") return false;
    el = el.parentElement;
  }
  return false;
}

/** mousedown → start the OS window drag. Left button only. */
export function beginWindowDrag(e: {
  button: number;
  target: EventTarget | null;
}): void {
  if (e.button !== 0) return;
  if (isInteractive(e.target)) return;
  void getCurrentWindow().startDragging();
}

/** dblclick → the platform's title-bar action (zoom on macOS). */
export function toggleWindowMaximize(e: { target: EventTarget | null }): void {
  if (isInteractive(e.target)) return;
  void getCurrentWindow().toggleMaximize();
}
