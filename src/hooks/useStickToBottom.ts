// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Follow a streaming thread only while the reader is parked at the bottom.
//!
//! The identical 40px block was copy-pasted in five chat surfaces
//! (`BrowserChat`, `LinkedChat`, `MissionChat`, `ChatRoom`, `MemoryAsk`).
//! Lifting it is not tidying: the turn footer changes every settled bubble's
//! height, so all five would otherwise need the same fix independently — and
//! the one that got missed would silently stop following.
//!
//! A `deps` change is not the only thing that moves the bottom. The viewport
//! shrinks under a queue tray or a notice, and the row at the end grows when
//! its status line arrives or a diagram finishes rendering — none of which is
//! a new message or a new token. While the reader is parked, a size watch on
//! the viewport and on that last row re-pins through all of it, in the same
//! frame, so the newest line is never left hidden until the next delta.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** How close to the bottom still counts as "parked there". Wide enough to
 *  survive sub-pixel rounding. */
const STICK_THRESHOLD_PX = 40;

export interface StickToBottom<E extends HTMLElement> {
  /** Attach to the scrolling container. */
  ref: React.RefObject<E | null>;
  /** Attach to its `onScroll`. */
  onScroll: () => void;
  /** Re-arm following — call when the thread's identity changes. */
  stick: () => void;
  /** Go to the newest line now, and follow from there. */
  jump: () => void;
  /** Stop following and rest the view at `top`. */
  park: (top: number) => void;
}

export interface StickOptions {
  /** How close to the bottom counts as there. */
  threshold?: number;
  /** Told each time following starts or stops, for a surface that shows it. */
  onFollow?: (following: boolean) => void;
}

/**
 * @param deps values whose change should scroll to the bottom (the message
 *        list and the streaming text). Passed as an array, spread into the
 *        effect's dependency list.
 */
export function useStickToBottom<E extends HTMLElement = HTMLDivElement>(
  deps: readonly unknown[],
  { threshold = STICK_THRESHOLD_PX, onFollow }: StickOptions = {},
): StickToBottom<E> {
  const ref = useRef<E | null>(null);
  const stuck = useRef(true);
  const watch = useRef<{ observer: ResizeObserver; el: E; last: Element | null } | null>(null);
  const onFollowRef = useRef(onFollow);
  onFollowRef.current = onFollow;
  const follow = useCallback((next: boolean) => {
    if (stuck.current === next) return;
    stuck.current = next;
    onFollowRef.current?.(next);
  }, []);

  const pin = useCallback(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, []);

  // Layout, not passive: the pin lands before the frame paints, so a frame
  // never shows the reply scrolled short of its newest line.
  useLayoutEffect(() => {
    pin();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Re-aimed only when the scroller or its last row is a different element
    // — once a turn, never once a token.
    const last = el.lastElementChild;
    if (watch.current?.el === el && watch.current.last === last) return;
    const observer = watch.current?.observer ?? new ResizeObserver(pin);
    observer.disconnect();
    observer.observe(el);
    if (last) observer.observe(last);
    watch.current = { observer, el, last };
    // The caller owns what "changed" means; this hook owns the rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(
    () => () => {
      watch.current?.observer.disconnect();
      watch.current = null;
    },
    [],
  );

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    follow(el.scrollHeight - el.scrollTop - el.clientHeight < threshold);
  }, [follow, threshold]);

  const stick = useCallback(() => follow(true), [follow]);

  const jump = useCallback(() => {
    follow(true);
    pin();
  }, [follow, pin]);

  const park = useCallback((top: number) => {
    follow(false);
    const el = ref.current;
    if (el) el.scrollTop = top;
  }, [follow]);

  return { ref, onScroll, stick, jump, park };
}
