// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useLayoutEffect, useRef } from "react";

/** A portal keeps its React identity while this host moves between surfaces. */
export function createBoundedPortalHost(name: string): HTMLDivElement {
  const host = document.createElement("div");
  host.dataset.portalHost = name;
  // Take no intrinsic space in the slot. A long thread or native-page fallback
  // must never make the workspace taller than the window.
  host.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden";
  return host;
}

/** Own the imperative child separately from React's ordinary surface bodies.
 *  The slot takes the host only while `active` (default true): a slot in a
 *  hidden kept tab stays mounted and must not steal the host from the one
 *  that is showing. Going inactive hands the host back the same way
 *  unmounting does. */
export function PersistentPortalSlot({ host, name, active = true }: { host: HTMLElement; name: string; active?: boolean }) {
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || !active) return;
    slot.appendChild(host);
    return () => {
      if (host.parentElement === slot) host.remove();
    };
  }, [host, active]);
  return <div ref={slotRef} data-surface-slot={name} data-slot-active={active ? "" : undefined} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" />;
}
