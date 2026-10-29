// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The end of a press, however it ends.
//
// A drag that starts in Redline's document can be let go over a native
// browser webview, or over anything AppKit hands the mouse-up to instead of
// this page: no `pointerup` ever reaches the document, and a drag waiting on
// one stays lit until the next click (LAST2 walk: a tab dropped on a wall, a
// plan edge or a browser edge; the rail seam dragged shut). So a press in
// flight listens for every way its release can show up:
//
//   * `pointerup` and `mouseup`, on the window in the capture phase, ahead of
//     anything under the pointer that keeps them;
//   * a mouse move with the button already up: the release it missed;
//   * `RELEASE_EVENT`, raised on the window when the release happened
//     somewhere this document cannot hear (a browser page's own mouse-up);
//   * the window server's button state (`pointer_pressed`), polled while
//     the press is in flight: the button up is the release, wherever it went.
//
// The caller's `onRelease` runs at most once per watch; `stop()` ends the
// watch without it.

import { invoke } from "@tauri-apps/api/core";

export const RELEASE_EVENT = "redline:press-release";

/** Where a release landed, when it is known. */
export type ReleasePoint = { x: number; y: number } | null;

/** How often a press in flight asks the window server whether the button is
 *  still held (`pointer_pressed`). */
const PRESSED_POLL_MS = 100;

export function watchRelease(onRelease: (at: ReleasePoint) => void): () => void {
  let done = false;
  // The last word: the window server's own button state. A release AppKit
  // gave to anything this document never hears still ends the press within
  // a poll. Only in the app (no Tauri, no poll), and an unanswered ask is
  // read as "still held".
  let poll: ReturnType<typeof setInterval> | undefined;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    poll = setInterval(() => {
      void invoke<boolean>("pointer_pressed")
        .then((held) => { if (!held) finish(null); })
        .catch(() => {});
    }, PRESSED_POLL_MS);
  }
  const finish = (at: ReleasePoint) => {
    if (done) return;
    stop();
    onRelease(at);
  };
  const onUp = (e: MouseEvent) => {
    if (e.button === 0) finish({ x: e.clientX, y: e.clientY });
  };
  const onMove = (e: MouseEvent) => {
    // A mouse's move: a pointer event that says so, or the mouse event itself.
    const mouse = e.type === "mousemove" || (e as PointerEvent).pointerType === "mouse";
    if (mouse && (e.buttons & 1) === 0) finish({ x: e.clientX, y: e.clientY });
  };
  const onElsewhere = () => finish(null);
  function stop() {
    done = true;
    if (poll !== undefined) clearInterval(poll);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener(RELEASE_EVENT, onElsewhere);
  }
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener(RELEASE_EVENT, onElsewhere);
  return stop;
}

/** A press inside a pane that its document never saw: a click in a browser
 *  page lands on the native webview, not on the pane's box (LAST2: it left
 *  the focus on the other pane). Raised, bubbling, from inside the pane by
 *  whoever heard the press; the pane box takes the focus as for its own. */
export const PANE_PRESS_EVENT = "redline:pane-press";
