// SPDX-License-Identifier: Apache-2.0
import { useCallback, useSyncExternalStore } from "react";

// Inline anchors and the island can show one thread simultaneously. A shared
// snapshot prevents a stale inline mount overwriting the island's newer draft.
const listeners = new Map<string, Set<() => void>>();
const fallback = new Map<string, string>();
function read(key: string): string {
  if (fallback.has(key)) return fallback.get(key)!;
  try { const value = JSON.parse(localStorage.getItem(key) ?? '""'); return typeof value === "string" ? value : ""; }
  catch { return fallback.get(key) ?? ""; }
}
export function useSharedDraft(key: string): [string, (next: string | ((previous: string) => string)) => void] {
  const subscribe = useCallback((listener: () => void) => {
    let set = listeners.get(key); if (!set) { set = new Set(); listeners.set(key, set); }
    set.add(listener);
    const external = (event: StorageEvent) => { if (event.key === key) listener(); };
    window.addEventListener("storage", external);
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); window.removeEventListener("storage", external); };
  }, [key]);
  const snapshot = useCallback(() => read(key), [key]);
  const value = useSyncExternalStore(subscribe, snapshot);
  const update = useCallback((next: string | ((previous: string) => string)) => {
    const value = typeof next === "function" ? next(read(key)) : next;
    fallback.set(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); fallback.delete(key); } catch { /* Private storage still keeps the live draft. */ }
    listeners.get(key)?.forEach(listener => listener());
  }, [key]);
  return [value, update];
}
