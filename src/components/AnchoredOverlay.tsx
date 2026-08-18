// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeByRect, rectOf, type AnchorRect } from "../lib/anchorPlacement";
import { rafCoalesce } from "../lib/raf";

// One overlay mechanism for everything the drafter floats over the document:
// the Keep/Revert chip, the selection menu, the comment composer, the ✦ Ask
// composer.
//
// The four it replaces were each `position: fixed` children of the SCROLL
// CONTAINER, which is precisely the bug `popover.tsx` already documents: a
// fixed child inside a contained/scrolled subtree is positioned against that
// subtree and clipped to it. So none of them followed scroll — they simply sat
// where the anchor USED to be. This portals to `document.body` for real
// viewport coordinates, and re-measures on every scroll.
//
// Positioning is written to `el.style.transform` in a LAYOUT effect, not to
// React state. The reason is stated verbatim in useTextClearance: this runs on
// every frame of a scroll, and a state flip here would re-render the drafter's
// whole document column — the exact cost the jank fix just removed.

export interface AnchoredOverlayProps {
  /** Live anchor rect, in viewport coordinates. Re-read on every measure —
   *  passing a captured rect is what made the old chips point at stale
   *  coordinates after an edit reflowed the line. */
  anchor: () => AnchorRect | null;
  /** The element whose box the overlay must stay inside: the PANE. */
  boundsRef: React.RefObject<HTMLElement | null>;
  /** Preferred side of the anchor. Flips when there isn't room. */
  prefer?: "above" | "below";
  gap?: number;
  /** Extra re-measure trigger, as a SUBSCRIPTION rather than a state nonce.
   *
   *  The obvious design — a `nonce` prop the host bumps on every document
   *  change — re-renders the host on every keystroke, which is precisely the
   *  jank the drafter just stopped paying. Here the host hands over a
   *  subscribe function (`cb => { editor.on("update", cb); return () => ... }`)
   *  and the measurement never touches React at all. */
  subscribe?: (remeasure: () => void) => () => void;
  /** Called when the anchor leaves the pane — the overlay should retire
   *  rather than hover at the edge pointing at nothing. */
  onVanish?: () => void;
  className?: string;
  /** Extra style for the floating box. Positioning keys are owned here and
   *  will win — pass appearance and sizing only. */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function AnchoredOverlay({
  anchor,
  boundsRef,
  prefer = "above",
  gap,
  subscribe,
  onVanish,
  className,
  style,
  children,
}: AnchoredOverlayProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  // Mount hidden. The first paint happens before the layout effect can measure,
  // and an overlay flashing at (0,0) before jumping to its anchor is worse than
  // one frame of nothing.
  const [ready, setReady] = useState(false);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const onVanishRef = useRef(onVanish);
  onVanishRef.current = onVanish;

  useLayoutEffect(() => {
    const measure = () => {
      const el = elRef.current;
      const bounds = rectOf(boundsRef.current);
      const target = anchorRef.current();
      if (!el || !bounds || !target) return;
      const box = el.getBoundingClientRect();
      const p = placeByRect(
        target,
        { width: box.width, height: box.height },
        { bounds, prefer, gap },
      );
      if (!p.visible) {
        onVanishRef.current?.();
        return;
      }
      // Transform, not left/top: it stays off the layout path entirely, so a
      // scroll never invalidates layout for the document underneath.
      el.style.transform = `translate3d(${Math.round(p.left)}px, ${Math.round(p.top)}px, 0)`;
      el.dataset.side = p.side;
      setReady(true);
    };

    measure();
    const onFrame = rafCoalesce(measure);
    // `capture: true` is the whole "none of them follows scroll" fix — the
    // scroll happens on an ancestor container, and a bubbling listener on
    // window never sees it.
    window.addEventListener("scroll", onFrame, true);
    window.addEventListener("resize", onFrame);
    const unsubscribe = subscribe?.(onFrame);
    return () => {
      onFrame.cancel();
      unsubscribe?.();
      window.removeEventListener("scroll", onFrame, true);
      window.removeEventListener("resize", onFrame);
    };
  }, [boundsRef, prefer, gap, subscribe]);

  // Content can change size after mount (a composer growing with its text);
  // re-measure when it does rather than leaving it hanging off its old box.
  useEffect(() => {
    const el = elRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      window.dispatchEvent(new Event("resize"));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return createPortal(
    <div
      ref={elRef}
      data-no-drag="true"
      className={className}
      style={{
        ...style,
        position: "fixed",
        left: 0,
        top: 0,
        zIndex: 60,
        // Hidden until placed — never a flash at the origin.
        visibility: ready ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
