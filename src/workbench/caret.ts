// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A caret nobody can see. xterm keeps keyboard focus in a hidden helper
// <textarea>; when the terminal layer leaves the screen, a blur alone is not
// enough: WebKit still treats the textarea as the first responder's text
// field, and macOS keeps drawing its input-source bubble wherever that field
// last sat — mid-plan, over the status bar (the re-walk's three captures).
// So leaving the terminals hands focus to a REAL, visible, focusable element:
// the shown tab's focused pane root (a `tabIndex={-1}` box, never a text
// field), and the layer, while off screen, parks every helper textarea out
// of the window (styles.css, `.rl-wb-terminal-layer[data-offscreen]`).

/** The pane a shown tab's caret belongs on: its focused pane, else any pane
 *  of the shown tab. Hidden kept tabs carry `data-hidden` and are skipped. */
export function visiblePaneRoot(doc: Document = document): HTMLElement | null {
  return (
    doc.querySelector<HTMLElement>(".rl-wb-tab-body:not([data-hidden]) .rl-wb-pane[data-focused]") ??
    doc.querySelector<HTMLElement>(".rl-wb-tab-body:not([data-hidden]) .rl-wb-pane")
  );
}

/** Let go of a caret `layer` holds as it leaves the screen: blur it, and
 *  give the focus to the shown tab's pane root so no text field (xterm's
 *  helper textarea above all) is left as the window's first responder.
 *  True when it moved the caret. */
export function releaseHiddenCaret(layer: HTMLElement | null, doc: Document = document): boolean {
  const held = doc.activeElement;
  if (!(held instanceof HTMLElement) || !layer?.contains(held)) return false;
  held.blur();
  const target = visiblePaneRoot(doc);
  if (target && !layer.contains(target)) target.focus({ preventScroll: true });
  return true;
}
