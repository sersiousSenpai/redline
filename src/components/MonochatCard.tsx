// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { useNativeOverlayRegion } from "../hooks/useNativeOverlayRegion";
import { springInKeyframes, SWAP_MS, SWAP_SPRING } from "../lib/springSwap";
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
// or the pointer on it. A menu the card opened is dismissed first, on its own.

/** The grace for the pointer to cross between the pill and the card. */
const LEAVE_CLOSE_MS = 350;

/** A menu, picker or dialog layered over the card owns the pointer and Esc. */
const hasChildOverlay = () => !!document.querySelector('[role="menu"], [role="dialog"], dialog[open]');

export default function MonochatCard({ pill, hovered, onClose, onRelease, children }: {
  /** The footer pill: the card springs out of it, and the pointer resting on
   *  it is resting on the card. */
  pill: RefObject<HTMLElement | null>;
  /** Whether the pointer is on the pill right now. The card's chunk can land
   *  after the pointer has already moved on. */
  hovered: () => boolean;
  onClose: () => void;
  /** The card's last word as it leaves: whether it held the caret. */
  onRelease: (focusInside: boolean) => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [springing, setSpringing] = useState(false);
  const pinned = useRef(false), over = useRef(false), leave = useRef(0);
  const close = useRef(onClose); close.current = onClose;
  const release = useRef(onRelease); release.current = onRelease;
  // The hole in the native webview tracks the spring frame by frame.
  useNativeOverlayRegion(box, true, springing);

  useLayoutEffect(() => {
    const card = box.current;
    if (!card) return;
    const from = (pill.current?.querySelector(".rl-portal-membrane") ?? pill.current)?.getBoundingClientRect();
    let animation: Animation | undefined;
    if (from && card.animate && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setSpringing(true);
      animation = card.animate(springInKeyframes(from, card.getBoundingClientRect()), { duration: SWAP_MS, easing: SWAP_SPRING });
      animation.onfinish = () => setSpringing(false);
    }
    // Before the node leaves the document, while the caret can still be
    // found inside it.
    return () => { animation?.cancel(); release.current(card.contains(document.activeElement)); };
    // The pill is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const card = box.current, button = pill.current;
    if (!card) return;
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
    // Arriving after the pointer already left: the leave starts now.
    if (hovered()) over.current = true;
    else exit();
    // A press anywhere else. Not consumed: it lands on what it was aimed at.
    const outside = (event: PointerEvent) => {
      if (inside(event.target) || hasChildOverlay()) return;
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
    card.addEventListener("focusin", pin);
    card.addEventListener("keydown", pin, true);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("redline:page-press", page);
    window.addEventListener("keydown", escape);
    window.addEventListener("keydown", escapeOver, true);
    return () => {
      window.clearTimeout(leave.current);
      for (const node of [card, button]) {
        node?.removeEventListener("pointerover", enter);
        node?.removeEventListener("pointerout", exit);
      }
      card.removeEventListener("pointerdown", pin, true);
      card.removeEventListener("focusin", pin);
      card.removeEventListener("keydown", pin, true);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("redline:page-press", page);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("keydown", escapeOver, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={box} id="rl-monochat-card" className="rl-monochat-float" role="region" aria-label="Redline" data-drop-cover>
    <div className="rl-float-heading">
      <span>Redline</span>
      <button type="button" aria-label="Collapse Redline" title="Collapse (Esc)" onClick={() => close.current()}><ChevronDown size={16}/></button>
    </div>
    {children}
  </div>;
}
