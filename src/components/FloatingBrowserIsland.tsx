// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useNativeOverlayRegion } from "../hooks/useNativeOverlayRegion";
import { isFrontDoorKey } from "../lib/keymap";
import { springInKeyframes, SWAP_MS, SWAP_SPRING } from "../lib/springSwap";
import "./FloatingBrowserIsland.css";
export default function FloatingBrowserIsland({ busy, open: controlled, onOpenChange, children }: { busy: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }) {
  const [localOpen, setLocalOpen] = useState(false), [animating, setAnimating] = useState(false);
  const open = controlled ?? localOpen;
  const pill = useRef<HTMLButtonElement>(null), box = useRef<HTMLDivElement>(null);
  const enter = useRef(0), leave = useRef(0), focusOnOpen = useRef(false), previousFocus = useRef<HTMLElement | null>(null);
  const change = (next: boolean, focus = false) => { focusOnOpen.current = focus; setLocalOpen(next); onOpenChange?.(next); };
  const changeRef = useRef(change); changeRef.current = change;
  useNativeOverlayRegion(pill, !open);
  useNativeOverlayRegion(box, open, animating);
  const clearTimers = () => { window.clearTimeout(enter.current); window.clearTimeout(leave.current); };
  const sticky = () => busy || !!box.current?.querySelector<HTMLTextAreaElement>("textarea")?.value.trim() || !!box.current?.contains(document.activeElement) || !!document.querySelector('[role="menu"], [role="dialog"], dialog[open]');
  const hover = () => { window.clearTimeout(leave.current); if (!open) enter.current = window.setTimeout(() => changeRef.current(true), 120); };
  const exit = () => { window.clearTimeout(enter.current); leave.current = window.setTimeout(() => { if (!sticky()) changeRef.current(false); }, 400); };
  useEffect(() => () => clearTimers(), []);
  useEffect(() => {
    const summon = () => { changeRef.current(true, true); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (open && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); clearTimers(); changeRef.current(false); }
      else if (!open && isFrontDoorKey(event)) { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) summon(); }
    };
    window.addEventListener("keydown", key, true); window.addEventListener("redline:open-front-door", summon);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("redline:open-front-door", summon); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let animation: Animation | undefined;
    if (!reduced && box.current.animate && pill.current) {
      setAnimating(true);
      animation = box.current.animate(springInKeyframes(pill.current.getBoundingClientRect(), box.current.getBoundingClientRect()), { duration: SWAP_MS, easing: SWAP_SPRING });
      animation.onfinish = () => setAnimating(false);
    }
    if (focusOnOpen.current) box.current.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    return () => { animation?.cancel(); setAnimating(false); if (box.current?.contains(document.activeElement)) previousFocus.current?.focus({ preventScroll: true }); };
  }, [open]);
  return <div className="rl-browser-island" onPointerEnter={hover} onPointerLeave={exit} onBlur={exit}>
    <button ref={pill} className="rl-monochat-notch" data-hidden={open} data-busy={busy} aria-hidden={open} tabIndex={open ? -1 : 0} aria-expanded={open} aria-controls="rl-browser-prompter" aria-label="Open browser prompter" title="Redline (Shift+Enter)" onClick={() => change(true, true)}><span className="rl-portal-membrane"><span className="rl-monochat-signal"><i/><i/><i/></span><span>{busy ? "Working" : "Redline"}</span></span></button>
    {open && <div ref={box} id="rl-browser-prompter" className="rl-monochat-float" role="region" aria-label="Browser prompter"><div className="rl-float-heading"><span>Redline</span><button type="button" aria-label="Collapse browser prompter" onClick={() => { clearTimers(); change(false); }}><ChevronDown size={16}/></button></div>{children}</div>}
  </div>;
}
