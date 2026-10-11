// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { useNativeOverlayRegion } from "../hooks/useNativeOverlayRegion";
import { flipBackKeyframes, flipKeyframes, ISLAND_EASE_IN, ISLAND_FADE_MS, ISLAND_SPRING_MS, SWAP_SPRING, type SwapRect } from "../lib/springSwap";
import { isTitleBarPress } from "../lib/windowDrag";
// A menu, picker or modal layered over the card owns the pointer and Esc.
import { hasChildOverlay } from "./MonochatIsland";
import "./MonochatCard.css";

// The island's compact pose: the small composer that springs out of the footer
// pill when the pointer rests on it. A popover, not a modal: nothing behind it
// goes inert, and on the browser surface it is cut out of the native page
// rather than hiding it.
//
// Hover means look. The card never takes the caret, and it leaves 350 ms after
// the pointer leaves both it and the pill — unless it is PINNED, by a press,
// focus or a keystroke inside it this time it opened. An old draft pins
// nothing: the sentence is kept either way. Anything outside dismisses it,
// pinned or not, and the press still lands where it was aimed: a press
// anywhere else in Redline, a press inside the web page, Esc with the caret
// or the pointer on it. A menu the card opened is dismissed first, on its own;
// a press on bare title bar is a window drag, not a dismissal.
//
// It moves like an object coming out of the pill and going back into it: a
// FLIP spring from the pill's box (transform only, past 300 ms), the content
// fading in behind the shell, the corners settling from the pill's to its own;
// closing, the same path back, quick and accelerating. The cut-out in the
// native page follows it every frame. Under reduced motion it crossfades.

/** The grace for the pointer to cross between the pill and the card. */
const LEAVE_CLOSE_MS = 350;
/** Back into the pill: quick — it is putting itself away. */
const CARD_CLOSE_MS = 220;
/** The content (chips, field, tools) waits this long behind the shell... */
const CONTENT_DELAY_MS = 80;
/** ...and is gone in this much of the way back. */
const CONTENT_OUT_MS = 100;
/** The corners are paint: they settle inside the 300 ms budget, while the
 *  spring is still on its way in. */
const CORNER_MS = 300;

const box = (r: DOMRect): SwapRect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** The card's last word on its way out — back into the pill, or into the door
 *  growing out of it. */
export interface CardRelease {
  /** It held the caret. */
  caret: boolean;
  /** Where it was on screen: a door growing out of it starts here. */
  rect: SwapRect;
  /** Its field's selection, once it had been in use: the door picks it up. */
  selection: [number, number, "forward" | "backward" | "none"] | null;
}

/** The shell's corners between the pill and the card, counter-scaled so on
 *  screen they read as the pill's while the transform squeezes the box. */
function cornerKeyframes(pill: SwapRect, card: SwapRect, pillRadius: number, radius: number): Keyframe[] {
  return [{ borderRadius: pillCorners(pill, card, pillRadius) }, { borderRadius: `${radius}px` }];
}
function pillCorners(pill: SwapRect, card: SwapRect, radius: number): string {
  const r = Math.min(radius, pill.width / 2, pill.height / 2);
  return `${Math.round(r * card.width / pill.width)}px / ${Math.round(r * card.height / pill.height)}px`;
}

export default function MonochatCard({ pill, open, growing = false, hovered, onClose, onRelease, onGone, children }: {
  /** The footer pill: the card springs out of it, goes back into it, and the
   *  pointer resting on it is resting on the card. */
  pill: RefObject<HTMLElement | null>;
  /** False: on its way back into the pill. It stays mounted for that, then
   *  calls `onGone`; true again on the way turns it round where it is. */
  open: boolean;
  /** The door is opening out of it: it hands over its box and selection and
   *  is gone at once — the door is the motion. */
  growing?: boolean;
  /** Whether the pointer is on the pill right now. The card's chunk can land
   *  after the pointer has already moved on. */
  hovered: () => boolean;
  onClose: () => void;
  /** Said as it starts to leave — back into the pill, or into a door growing
   *  out of it — before anything moves or the caret goes anywhere. */
  onRelease: (release: CardRelease) => void;
  onGone: () => void;
  children: ReactNode;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const heading = useId();
  const [moving, setMoving] = useState(false);
  const pinned = useRef(false), over = useRef(false), leave = useRef(0);
  // Its field was used this opening: a door growing out of it takes the
  // selection along, rather than putting the caret at the end.
  const used = useRef(false);
  const opened = useRef(false);
  const flight = useRef<Animation[]>([]);
  const close = useRef(onClose); close.current = onClose;
  const release = useRef(onRelease); release.current = onRelease;
  const gone = useRef(onGone); gone.current = onGone;
  // The hole in the native webview tracks the flight frame by frame.
  useNativeOverlayRegion(shell, true, moving);

  useLayoutEffect(() => {
    const card = shell.current, inner = content.current;
    if (!card || !inner) return;
    // Turned round mid-flight: on from wherever it has got to.
    const now = flight.current.length ? box(card.getBoundingClientRect()) : null;
    const shown = flight.current.length ? Number(getComputedStyle(inner).opacity) : 0;
    if (!open) {
      const field = card.querySelector("textarea");
      release.current({
        caret: card.contains(document.activeElement),
        rect: now ?? box(card.getBoundingClientRect()),
        selection: field && used.current ? [field.selectionStart, field.selectionEnd, field.selectionDirection] : null,
      });
    }
    for (const animation of flight.current) animation.cancel();
    flight.current = [];
    // Closed before its chunk even landed: nothing to put away.
    if (growing || !open && !opened.current) { gone.current(); return; }
    opened.current = true;
    const membrane = pill.current?.querySelector<HTMLElement>(".rl-portal-membrane") ?? pill.current;
    if (!card.animate || !membrane) { if (!open) gone.current(); return; }
    const home = box(membrane.getBoundingClientRect()), own = box(card.getBoundingClientRect());
    const corner = parseFloat(getComputedStyle(membrane).borderTopLeftRadius) || 0;
    const radius = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0;
    // Read live, so a change of the system setting applies from the next flight.
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) {
      flight.current = [card.animate([{ opacity: open ? 0 : 1 }, { opacity: open ? 1 : 0 }], { duration: ISLAND_FADE_MS, fill: "forwards" })];
    } else if (open) {
      flight.current = [
        card.animate(flipKeyframes(now ?? home, own), { duration: ISLAND_SPRING_MS, easing: SWAP_SPRING }),
        card.animate(cornerKeyframes(now ?? home, own, corner, radius), { duration: CORNER_MS, easing: SWAP_SPRING }),
        inner.animate([{ opacity: shown }, { opacity: 1 }], { duration: ISLAND_SPRING_MS - CONTENT_DELAY_MS, delay: now ? 0 : CONTENT_DELAY_MS, fill: "backwards" }),
      ];
    } else {
      flight.current = [
        card.animate(flipBackKeyframes(home, own), { duration: CARD_CLOSE_MS, easing: ISLAND_EASE_IN, fill: "forwards" }),
        card.animate(cornerKeyframes(home, own, corner, radius).reverse(), { duration: CARD_CLOSE_MS, easing: ISLAND_EASE_IN, fill: "forwards" }),
        inner.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CONTENT_OUT_MS, fill: "forwards" }),
      ];
    }
    setMoving(true);
    flight.current[0].onfinish = () => {
      if (!open) return gone.current();
      for (const animation of flight.current) animation.cancel();
      flight.current = [];
      setMoving(false);
    };
    // The pill is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, growing]);
  useLayoutEffect(() => () => {
    for (const animation of flight.current) animation.cancel();
    flight.current = [];
  }, []);

  useEffect(() => {
    const card = shell.current, button = pill.current;
    if (!card || !open) return;
    pinned.current = false;
    used.current = false;
    const inside = (target: EventTarget | null) => target instanceof Node && (card.contains(target) || !!button?.contains(target));
    const enter = () => { over.current = true; window.clearTimeout(leave.current); };
    const exit = (event?: PointerEvent) => {
      if (event && inside(event.relatedTarget)) return;
      over.current = false;
      window.clearTimeout(leave.current);
      leave.current = window.setTimeout(() => {
        if (!pinned.current && !over.current && !hasChildOverlay()) close.current();
      }, LEAVE_CLOSE_MS);
    };
    const pin = () => { pinned.current = true; window.clearTimeout(leave.current); };
    const focus = (event: FocusEvent) => { pin(); if (event.target instanceof HTMLTextAreaElement) used.current = true; };
    // Arriving after the pointer already left: the leave starts now.
    if (hovered()) over.current = true;
    else exit();
    // A press anywhere else. Not consumed: it lands on what it was aimed at.
    // Bare title bar is the start of a window drag, which is not "elsewhere".
    const outside = (event: PointerEvent) => {
      if (inside(event.target) || hasChildOverlay() || isTitleBarPress(event.target)) return;
      close.current();
    };
    // A press inside the web page, which never reaches this document.
    const page = () => close.current();
    // Esc from inside goes after the card's own menus have had it.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || hasChildOverlay() || !(event.target instanceof Node) || !card.contains(event.target)) return;
      event.preventDefault(); event.stopPropagation();
      close.current();
    };
    // With the pointer on the card and the caret elsewhere, Esc is aimed at
    // the card — and must not also reach the terminal under it.
    const escapeOver = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !over.current || hasChildOverlay() || (event.target instanceof Node && card.contains(event.target))) return;
      event.preventDefault(); event.stopImmediatePropagation();
      close.current();
    };
    for (const node of [card, button]) {
      node?.addEventListener("pointerover", enter);
      node?.addEventListener("pointerout", exit);
    }
    card.addEventListener("pointerdown", pin, true);
    card.addEventListener("focusin", focus);
    card.addEventListener("keydown", pin, true);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("redline:page-press", page);
    window.addEventListener("keydown", escape);
    window.addEventListener("keydown", escapeOver, true);
    return () => {
      window.clearTimeout(leave.current);
      over.current = false;
      for (const node of [card, button]) {
        node?.removeEventListener("pointerover", enter);
        node?.removeEventListener("pointerout", exit);
      }
      card.removeEventListener("pointerdown", pin, true);
      card.removeEventListener("focusin", focus);
      card.removeEventListener("keydown", pin, true);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("redline:page-press", page);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("keydown", escapeOver, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return <div ref={shell} id="rl-monochat-card" className="rl-monochat-float" role="region" aria-labelledby={heading} data-drop-cover data-leaving={!open || undefined}>
    <div ref={content}>
      <div className="rl-float-heading">
        <h2 id={heading}>Redline</h2>
        <button type="button" aria-label="Collapse Redline" title="Collapse (Esc)" onClick={() => close.current()}><ChevronDown size={16}/></button>
      </div>
      {children}
    </div>
  </div>;
}
