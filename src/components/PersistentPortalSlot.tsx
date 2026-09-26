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

/** Own the imperative child separately from React's ordinary surface bodies. */
export function PersistentPortalSlot({ host, name }: { host: HTMLElement; name: string }) {
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    slot.appendChild(host);
    return () => {
      if (host.parentElement === slot) host.remove();
    };
  }, [host]);
  return <div ref={slotRef} data-surface-slot={name} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" />;
}
