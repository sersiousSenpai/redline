// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  forgetQuieted,
  newTransitions,
  notificationFor,
  transitionKey,
  YOUR_TURN_NOTIFY_DELAY_MS,
  type LoudTerminal,
} from "../lib/attentionAlerts";
import { notify } from "../lib/osNotice";

/** The Dock badge and OS notifications for the terminals that need you.
 *
 *  `loud` is every loud terminal, oldest first. `ready` holds everything back
 *  until the daemon's snapshot has seeded it: transitions that happened
 *  before this dock mounted (a reload, a late mount) were never news to this
 *  window, so they are marked handled without notifying. After that, each
 *  new transition notifies once — if, at that moment, the window is not
 *  focused or the dock is collapsed. A your-turn waits
 *  YOUR_TURN_NOTIFY_DELAY_MS and is dropped if it was read or replaced in the
 *  meantime. */
export function useAttentionAlerts(
  loud: readonly LoudTerminal[],
  collapsed: boolean,
  ready: boolean,
): void {
  const loudRef = useRef(loud);
  loudRef.current = loud;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  // Whether Redline's window is the one in front. Not document.hasFocus():
  // that is false while the caret sits in one of Redline's own browser pages
  // (native webviews in this same window), and a notification then would be
  // about the app the user is looking at.
  const windowFocusedRef = useRef(document.hasFocus());
  useEffect(() => {
    const win = getCurrentWindow();
    let live = true;
    win.isFocused().then((focused) => { if (live) windowFocusedRef.current = focused; }, () => {});
    const un = win.onFocusChanged(({ payload }) => { windowFocusedRef.current = payload; });
    return () => {
      live = false;
      void un.then((off) => off(), () => {});
    };
  }, []);

  const badgeRef = useRef<number | null>(null);
  useEffect(() => {
    if (badgeRef.current === loud.length) return;
    badgeRef.current = loud.length;
    void invoke("set_attention_badge", { count: loud.length }).catch(() => {});
  }, [loud.length]);

  const handledRef = useRef<Set<string> | null>(null);
  const timersRef = useRef(new Set<number>());
  useEffect(() => {
    if (!ready) return;
    if (handledRef.current === null) {
      handledRef.current = new Set(loud.map(transitionKey));
      return;
    }
    const handled = handledRef.current;
    forgetQuieted(handled, loud);
    const away = () => !windowFocusedRef.current || collapsedRef.current;
    for (const t of newTransitions(loud, handled)) {
      handled.add(transitionKey(t));
      if (!away()) continue;
      if (t.state === "needs-you") {
        const { title, body } = notificationFor(t);
        void notify(title, body);
        continue;
      }
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer);
        const now = loudRef.current.find((x) => x.id === t.id);
        if (!now || now.at !== t.at || now.state !== t.state || !away()) return;
        const { title, body } = notificationFor(now);
        void notify(title, body);
      }, YOUR_TURN_NOTIFY_DELAY_MS);
      timersRef.current.add(timer);
    }
  }, [loud, ready]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
}
