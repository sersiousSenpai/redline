// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// One app-wide "a resize is in progress" signal.
//
// A drag frame should cost one custom-property write plus browser layout and
// nothing else. Everything expensive that would otherwise react to a size
// change mid-drag — xterm reflow + PTY resize, the latch/zoom-pill
// recomputations, the virtualized viewer's measure, localStorage — reads this
// instead and defers its real work to the end of the drag.
//
// Refcounted because more than one source can be resizing at once: a pointer
// drag on a divider while the OS window is also being resized. The DOM flag
// `<html data-rl-resizing>` mirrors the same state for CSS (see styles.css),
// so a stylesheet can suppress transitions without any component knowing.

type Listener = (active: boolean) => void;

let depth = 0;
const listeners = new Set<Listener>();

function setFlag(active: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root) return;
  if (active) root.dataset.rlResizing = "1";
  else delete root.dataset.rlResizing;
}

function notify(active: boolean) {
  // Snapshot: a listener may unsubscribe from inside its own callback.
  for (const fn of [...listeners]) {
    try {
      fn(active);
    } catch {
      /* one bad subscriber must not strand the session */
    }
  }
}

/** True while any drag / window resize is in flight. */
export function isResizing(): boolean {
  return depth > 0;
}

/** Open a session. Balanced by exactly one `endResizeSession`. */
export function beginResizeSession(): void {
  depth += 1;
  if (depth === 1) {
    setFlag(true);
    notify(true);
  }
}

/** Close a session. Extra calls are ignored rather than driving the count
 *  negative — an unbalanced end from one source must not leave the app stuck
 *  believing it is permanently resizing. */
export function endResizeSession(): void {
  if (depth === 0) return;
  depth -= 1;
  if (depth === 0) {
    setFlag(false);
    notify(false);
  }
}

/** Subscribe to begin (true) / end (false) transitions. Returns an unsubscribe.
 *  Only the outermost transitions fire — nested sessions are invisible here. */
export function onResizeSession(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Bridge native window resizing onto the same signal. There is no `pointerup`
 *  for an OS window drag (or the fullscreen toggle), so the session opens on
 *  the first `resize` event and closes on a trailing settle timer.
 *
 *  The adapter holds its own latch, so however many events arrive it
 *  contributes exactly one to the refcount and can never unbalance a
 *  concurrent pointer drag. Returns a teardown that also closes an open
 *  session. */
export function installWindowResizeSession(settleMs = 150): () => void {
  if (typeof window === "undefined") return () => {};
  let open = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = () => {
    timer = undefined;
    if (!open) return;
    open = false;
    endResizeSession();
  };

  const onResize = () => {
    if (!open) {
      open = true;
      beginResizeSession();
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(settle, settleMs);
  };

  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (open) {
      open = false;
      endResizeSession();
    }
  };
}

/** Test-only: drop every listener and force the count back to rest, so one
 *  test's unbalanced session cannot leak into the next. */
export function __resetResizeSession(): void {
  depth = 0;
  listeners.clear();
  setFlag(false);
}
