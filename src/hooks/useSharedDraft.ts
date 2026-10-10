// SPDX-License-Identifier: Apache-2.0
import { useCallback, useSyncExternalStore } from "react";

// Inline anchors and the island can show one thread simultaneously. A shared
// snapshot prevents a stale inline mount overwriting the island's newer draft.
//
// Memory is the source of truth: a snapshot is a Map lookup, never a
// JSON.parse of localStorage, and a keystroke never waits on a synchronous
// setItem. The disk copy trails by WRITE_DELAY_MS and every pending write
// lands the moment the page may be leaving: `pagehide` (a reload),
// `beforeunload` (quit tears the webview down, and that is the event still
// dispatched then) and the window hiding.
const WRITE_DELAY_MS = 300;
const listeners = new Map<string, Set<() => void>>();
const drafts = new Map<string, string>();
const unsaved = new Set<string>();
let writeTimer: ReturnType<typeof setTimeout> | undefined;

const notify = (key: string) => listeners.get(key)?.forEach(listener => listener());
function flush() {
  clearTimeout(writeTimer);
  for (const key of unsaved) {
    try { localStorage.setItem(key, JSON.stringify(drafts.get(key))); } catch { /* Private storage still keeps the live draft. */ }
  }
  unsaved.clear();
}
window.addEventListener("pagehide", flush);
window.addEventListener("beforeunload", flush);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});
// Another window wrote a draft this one holds. Theirs is the newer keystroke,
// so ours is forgotten and the next read takes theirs from the disk.
window.addEventListener("storage", event => {
  if (event.key && drafts.delete(event.key)) { unsaved.delete(event.key); notify(event.key); }
});

/** The draft under `key` right now, without subscribing to it. */
export function readSharedDraft(key: string): string {
  let value = drafts.get(key);
  if (value === undefined) {
    try { value = JSON.parse(localStorage.getItem(key) ?? '""'); } catch { /* An unreadable draft reads as empty. */ }
    if (typeof value !== "string") value = "";
    drafts.set(key, value);
  }
  return value;
}

/** Every mount showing `key` re-renders now; the disk follows on the debounce. */
export function writeSharedDraft(key: string, next: string | ((previous: string) => string)) {
  const previous = readSharedDraft(key);
  const value = typeof next === "function" ? next(previous) : next;
  if (value === previous) return;
  drafts.set(key, value);
  unsaved.add(key);
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, WRITE_DELAY_MS);
  notify(key);
}

function useSubscription(key: string) {
  return useCallback((listener: () => void) => {
    const set = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, set.add(listener));
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
  }, [key]);
}

export function useSharedDraft(key: string): [string, (next: string | ((previous: string) => string)) => void] {
  const value = useSyncExternalStore(useSubscription(key), () => readSharedDraft(key));
  const update = useCallback((next: string | ((previous: string) => string)) => writeSharedDraft(key, next), [key]);
  return [value, update];
}

/** Whether `key` holds a sentence, re-rendering only when that answer flips —
 *  never per keystroke. */
export function useHasSharedDraft(key: string): boolean {
  return useSyncExternalStore(useSubscription(key), () => readSharedDraft(key).trim() !== "");
}
