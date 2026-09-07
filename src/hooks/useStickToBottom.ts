// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Follow a streaming thread only while the reader is parked at the bottom.
//!
//! The identical 40px block was copy-pasted in five chat surfaces
//! (`BrowserChat`, `LinkedChat`, `MissionChat`, `ChatRoom`, `MemoryAsk`).
//! Lifting it is not tidying: the turn footer changes every settled bubble's
//! height, so all five would otherwise need the same fix independently — and
//! the one that got missed would silently stop following.

import { useCallback, useEffect, useRef } from "react";

/** How close to the bottom still counts as "parked there". Wide enough to
 *  survive sub-pixel rounding and the trailing cursor glyph. */
export const STICK_THRESHOLD_PX = 40;

export interface StickToBottom<E extends HTMLElement> {
  /** Attach to the scrolling container. */
  ref: React.RefObject<E | null>;
  /** Attach to its `onScroll`. */
  onScroll: () => void;
  /** Re-arm following — call when the thread's identity changes. */
  stick: () => void;
}

/**
 * @param deps values whose change should scroll to the bottom (the message
 *        list and the streaming text). Passed as an array, spread into the
 *        effect's dependency list.
 */
export function useStickToBottom<E extends HTMLElement = HTMLDivElement>(
  deps: readonly unknown[],
): StickToBottom<E> {
  const ref = useRef<E | null>(null);
  const stuck = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
    // The caller owns what "changed" means; this hook owns the rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuck.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  }, []);

  const stick = useCallback(() => {
    stuck.current = true;
  }, []);

  return { ref, onScroll, stick };
}
