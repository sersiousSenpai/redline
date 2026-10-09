// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  newTransitions,
  notificationFor,
  transitionKey,
  YOUR_TURN_NOTIFY_DELAY_MS,
  type LoudTerminal,
} from "../lib/attentionAlerts";

/** Permission is asked once per launch, at the first notification — never at
 *  boot, and never again after a "no". */
let permission: Promise<boolean> | null = null;

async function notify(title: string, body: string): Promise<void> {
  try {
    // Loaded at the first notification: nothing on the boot path pays for it.
    const plugin = await import("@tauri-apps/plugin-notification");
    permission ??= (async () =>
      (await plugin.isPermissionGranted()) ||
      (await plugin.requestPermission()) === "granted")();
    if (await permission) plugin.sendNotification({ title, body });
  } catch {
    // No plugin or no permission system (tests, a stripped build): stay
    // quiet, and ask again next time rather than caching the failure.
    permission = null;
  }
}

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
    const away = () => !document.hasFocus() || collapsedRef.current;
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
