// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// One router for OS file drops onto the main webview.
//
// HTML5 `drop` never fires in this app: `dragDropEnabled` defaults to true, so
// Tauri swallows OS drops at the webview and re-emits them as one
// webview-global event carrying real absolute paths. Every consumer (terminal,
// comment composers, the Front Door) used to listen to that event and
// hit-test for itself, and the terminal's "is anything else on top?" guard
// rejected valid drops whenever a pass-through overlay (the notch, a resting
// composer) sat above it.
//
// The rule now lives here, once: the topmost REGISTERED target under the
// pointer wins. Non-target overlays are looked through, so a composer that
// really is on top still wins and the notch never eats a drop. Not looked
// through: a modal dialog (or the cover behind it), and a floating surface
// marked `data-drop-cover` (the Redline card). A drop onto one goes nowhere
// rather than into whatever it covers; its own targets still take theirs.
//
// Positions are logical AppKit points, which are already CSS pixels: wry
// reports them unscaled (Tauri labels them "physical") and the webview's
// top-left is the CSS viewport origin. Do NOT divide by devicePixelRatio — on
// a Retina display that halves the point and misses any target that isn't
// pinned to the top-left.
//
// A drag that carries a file PROMISE (a screenshot thumbnail before it has
// settled, an image dragged out of Preview) arrives as a `drop` with no paths;
// the native side writes the files and follows up with PROMISED_DROP_EVENT,
// which is routed exactly the same way.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";

/** Emitted by `promised_drop.rs` once a promise-only drop's files exist. */
export const PROMISED_DROP_EVENT = "redline://promised-drop";

export interface PromisedDrop {
  paths: string[];
  position: { x: number; y: number };
}

interface DropTarget {
  onDrop: (paths: string[]) => void;
  onHover?: (over: boolean) => void;
}

const targets = new Map<HTMLElement, DropTarget>();
let hovered: HTMLElement | null = null;
/** Bumped by every install/uninstall, so a subscription that resolves after
 *  the last target left unsubscribes itself instead of leaking. */
let generation = 0;
let unlisteners: (() => void)[] = [];

/** Make `el` a drop target until the returned function is called. `onDrop`
 *  gets the absolute paths of a drop that resolved to `el`; `onHover` follows
 *  a drag in and out of it. */
export function registerFileDropTarget(
  el: HTMLElement,
  onDrop: (paths: string[]) => void,
  onHover?: (over: boolean) => void,
): () => void {
  const target: DropTarget = { onDrop, onHover };
  // Subscribe on the first target only: an element registering again while
  // it is still registered must not add a second subscription.
  if (targets.size === 0) install();
  targets.set(el, target);
  return () => {
    // A later registration of the same element owns it now.
    if (targets.get(el) !== target) return;
    targets.delete(el);
    if (hovered === el) {
      hovered = null;
      onHover?.(false);
    }
    if (targets.size === 0) uninstall();
  };
}

const MODAL = '[aria-modal="true"]';
/** A surface that isn't modal but still hides what is under it. */
const COVER = "[data-drop-cover]";

/** The registered target a drop at (x, y) belongs to, if any. */
export function fileDropTargetAt(x: number, y: number): HTMLElement | null {
  // Every layer under the point, topmost first.
  const stack = document.elementsFromPoint?.(x, y) ?? [];
  for (const hit of stack) {
    for (let n: Element | null = hit; n; n = n.parentElement) {
      if (targets.has(n as HTMLElement) && n.isConnected) return n as HTMLElement;
    }
    // A modal, the dimmed cover it sits on, or a marked cover ends the search.
    if (hit.closest(`${MODAL}, ${COVER}`) || [...hit.children].some((child) => child.matches(MODAL))) return null;
  }
  return null;
}

function install() {
  const gen = ++generation;
  const keep = (un: () => void) => {
    if (gen === generation) unlisteners.push(un);
    else un();
  };
  // Deferred a microtask so a missing Tauri runtime (tests) rejects instead
  // of throwing inside the caller's effect.
  void Promise.resolve()
    .then(() => getCurrentWebview().onDragDropEvent(({ payload }) => onNativeDrag(payload)))
    .then(keep)
    .catch(() => {});
  void Promise.resolve()
    .then(() => listen<PromisedDrop>(PROMISED_DROP_EVENT, ({ payload }) => deliver("promised-drop", payload.paths, payload.position)))
    .then(keep)
    .catch(() => {});
}

function uninstall() {
  generation++;
  hovered = null;
  for (const un of unlisteners.splice(0)) un();
}

function onNativeDrag(p: DragDropEvent) {
  if (p.type === "over" || p.type === "enter") {
    if (p.type === "enter") debug("enter", { paths: p.paths.length });
    setHovered(fileDropTargetAt(p.position.x, p.position.y));
    return;
  }
  setHovered(null);
  if (p.type === "leave") {
    debug("leave");
    return;
  }
  deliver("drop", p.paths, p.position);
}

function deliver(source: string, paths: string[] | undefined, position: { x: number; y: number }) {
  const count = paths?.length ?? 0;
  const el = count > 0 ? fileDropTargetAt(position.x, position.y) : null;
  debug(source, { paths: count, target: describe(el) });
  if (el && paths) targets.get(el)?.onDrop(paths);
}

function setHovered(el: HTMLElement | null) {
  if (el === hovered) return;
  const prev = hovered;
  hovered = el;
  if (prev) targets.get(prev)?.onHover?.(false);
  if (el) targets.get(el)?.onHover?.(true);
  debug("hover", describe(el));
}

/** `div.rl-fd-island` — enough to tell the targets apart in a log. */
function describe(el: Element | null): string {
  return el ? el.tagName.toLowerCase() + [...el.classList].map((c) => `.${c}`).join("") : "none";
}

/** Dev-only breadcrumbs: the first real drag says whether an event reaches
 *  `main` at all. If none does, a native browser webview is taking it. */
function debug(...args: unknown[]) {
  if (import.meta.env.DEV) console.debug("[redline:drop]", ...args);
}
