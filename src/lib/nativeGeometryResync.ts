// SPDX-License-Identifier: Apache-2.0
import { dropListener } from "./dropListener";
/** The events after which a native child webview's frame can no longer be
 * trusted, though the DOM host it follows may not have changed at all: the
 * window resized, moved or changed scale; it entered or left full screen, was
 * restored from the Dock or moved screens; the Mac woke or its displays
 * changed; the app became active; the document became visible again. Each
 * asks for one resync, coalesced to one per animation frame. Event-driven
 * only: nothing here runs while the app is idle. */
export type GeometryResyncReason =
  | "resized" | "moved" | "scale" | "focused" | "visible" | "native";

/** Tauri's window and event subscriptions, injected so tests can drive them. */
export interface GeometryResyncSources {
  onResized(handler: () => void): Promise<() => void>;
  onMoved(handler: () => void): Promise<() => void>;
  onScaleChanged(handler: () => void): Promise<() => void>;
  onFocusChanged(handler: (focused: boolean) => void): Promise<() => void>;
  /** The native side's `browser-geometry-stale` event: full-screen enter and
   * exit, backing-scale and screen changes, de-miniaturize, wake, display
   * reconfiguration, app activation. */
  onNativeStale(handler: () => void): Promise<() => void>;
  document?: Document;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export function subscribeGeometryResync(sources: GeometryResyncSources, resync: (reasons: Set<GeometryResyncReason>) => void): () => void {
  const doc = sources.document ?? document;
  const requestFrame = sources.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = sources.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  let frame = 0;
  let disposed = false;
  let pending = new Set<GeometryResyncReason>();
  const request = (reason: GeometryResyncReason) => {
    if (disposed) return;
    pending.add(reason);
    if (frame) return;
    frame = requestFrame(() => {
      frame = 0;
      const reasons = pending;
      pending = new Set();
      if (!disposed) resync(reasons);
    });
  };
  const onVisibility = () => { if (doc.visibilityState === "visible") request("visible"); };
  doc.addEventListener("visibilitychange", onVisibility);
  const unlisteners: (() => void)[] = [];
  // One source failing to subscribe (an older runtime, a test double) must
  // not take the others down with it.
  const keep = (subscribe: () => Promise<() => void>) => {
    let subscription: Promise<() => void>;
    try { subscription = subscribe(); } catch { return; }
    void subscription.then((unlisten) => {
      if (disposed) dropListener(unlisten); else unlisteners.push(unlisten);
    }).catch(() => {});
  };
  keep(() => sources.onResized(() => request("resized")));
  keep(() => sources.onMoved(() => request("moved")));
  keep(() => sources.onScaleChanged(() => request("scale")));
  keep(() => sources.onFocusChanged((focused) => { if (focused) request("focused"); }));
  keep(() => sources.onNativeStale(() => request("native")));
  return () => {
    disposed = true;
    if (frame) cancelFrame(frame);
    frame = 0;
    doc.removeEventListener("visibilitychange", onVisibility);
    for (const unlisten of unlisteners.splice(0)) dropListener(unlisten);
  };
}

/** A window move or a live resize streams events every frame, and the host's
 * fresh measurement catches any real change there. The rest are discrete
 * moments where the native frame itself may have shifted under an unchanged
 * host, so those re-apply even an equal rect. */
export function resyncForcesReapply(reasons: Set<GeometryResyncReason>): boolean {
  for (const reason of reasons) if (reason !== "moved" && reason !== "resized") return true;
  return false;
}
