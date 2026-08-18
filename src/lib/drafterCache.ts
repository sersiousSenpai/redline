// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { JSONContent } from "@tiptap/react";

// --- Drafter crash shadow ---------------------------------------------------
// A synchronous localStorage copy of the open document, written on every flush
// BEFORE the async DB invoke, cleared once the write confirms. Deliberately
// localStorage — but strictly as a crash journal, never primary storage (which
// is exactly what the Bookshelf moved away from). Bounded to the open document.

export interface DrafterShadow {
  json: JSONContent;
  markdown: string;
  at: number;
}

/** The slice of Storage the shadow helpers touch — narrow so tests can hand
 *  in a plain in-memory stub. `localStorage` satisfies it. */
export type ShadowStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const drafterShadowKey = (id: string) => `redline.drafter.shadow.${id}`;

/** Whether this document is in Suggesting mode. Namespaced like everything
 *  else the app stores — it was the one key living outside `redline.*`. */
export const drafterModeKey = (id: string) => `redline.drafter.mode.${id}`;

export function readDrafterShadow(
  id: string,
  storage: ShadowStorage = localStorage,
): DrafterShadow | null {
  try {
    const raw = storage.getItem(drafterShadowKey(id));
    if (!raw) return null;
    const s = JSON.parse(raw) as DrafterShadow;
    return s && typeof s.at === "number" && s.json ? s : null;
  } catch {
    return null;
  }
}

export function clearDrafterShadow(
  id: string,
  storage: ShadowStorage = localStorage,
): void {
  try {
    storage.removeItem(drafterShadowKey(id));
  } catch {
    /* nothing to clear, or storage unavailable — either way it's gone */
  }
}

// --- In-session document cache ----------------------------------------------
// The host keeps the latest content ever on screen for every draft opened this
// session (written on the same flush that writes the shadow). The invariant it
// buys: whenever the drafter editor mounts, its `doc` is that latest content —
// never a stale DB snapshot from the persist retry window, never a blank for a
// doc whose first debounced write hasn't landed yet.

export interface DrafterSessionEntry {
  json: JSONContent;
  projectPath: string | null;
  at: number;
}

/** Where an opening draft's content comes from, in strict precedence order. */
export type OpenSource = "session" | "shadow-prompt" | "db";

/** Pure open-time decision. A session entry wins outright — in-session,
 *  in-memory ≥ DB always (during the persist retry window the DB is behind,
 *  and the backend never writes doc_json for an open doc: agent/voice flushes
 *  pass doc_json: None, COALESCE-preserved), and it must never trigger the
 *  recovery prompt. With no entry, a shadow strictly newer than the DB row
 *  means the app died between a keystroke and its write landing — offer it
 *  (`dbUpdatedAt` 0 = no row yet, so a fresh doc's shadow always prompts).
 *  Otherwise the DB copy is the truth. */
export function resolveDraftOpen(
  entry: DrafterSessionEntry | null,
  dbUpdatedAt: number,
  shadowAt: number | null,
): OpenSource {
  if (entry) return "session";
  if (shadowAt !== null && shadowAt > dbUpdatedAt) return "shadow-prompt";
  return "db";
}

/** Everything one flush of the open document writes, and the order it writes
 *  them in. The order is the contract:
 *
 *  1. the crash shadow, SYNCHRONOUSLY, before anything can await — a hard kill
 *     between a keystroke and the DB write must lose nothing;
 *  2. the in-session cache, so a remount this session finds current content
 *     even while the DB is behind in the persist retry window;
 *  3. the DB.
 *
 *  Injected deps, because that contract used to be pinned by three `indexOf`
 *  assertions against App.tsx's *source text* — which pass if you merely
 *  reorder the comments. They existed because the contract lived inside a
 *  7,000-line component. Extraction is the fix, and this is it. */
export interface DrafterFlushDeps {
  storage: ShadowStorage;
  cache: Map<string, DrafterSessionEntry>;
  persist: (
    id: string,
    markdown: string,
    json: JSONContent,
    project: string | null,
  ) => Promise<unknown>;
  now: () => number;
}

export function writeDrafterFlush(
  id: string,
  json: JSONContent,
  markdown: string,
  project: string | null,
  deps: DrafterFlushDeps,
): Promise<unknown> {
  const at = deps.now();
  try {
    deps.storage.setItem(
      drafterShadowKey(id),
      JSON.stringify({ json, markdown, at } as DrafterShadow),
    );
  } catch {
    /* quota / private mode — the DB write below is still the real path */
  }
  deps.cache.set(id, { json, projectPath: project, at });
  return deps.persist(id, markdown, json, project);
}

/** What the editor should MOUNT with, resolved at the mount site.
 *
 *  `drafterLoaded` used to be refreshed on every 400ms persist flush purely so
 *  a remount would find current content — a write-only feedback loop that
 *  changed a prop `PromptDrafter` contractually ignores after mount, defeating
 *  its `memo()` on every debounce for nothing.
 *
 *  Dropping that refresh alone is NOT safe: three paths remount the editor
 *  without changing the active draft id (the shelf toggle, a surface switch,
 *  the pinned-doc toggle), and the load effect keys on the id so it can't
 *  re-run. This reads the session cache instead, which is strictly fresher by
 *  construction — it is written unconditionally on every flush, under the
 *  flush's own id, while `drafterLoaded` was written only when the id still
 *  matched.
 *
 *  `null` means "not ready" — the host renders its loading state rather than
 *  mounting TipTap over a document it doesn't have yet. */
export function resolveDrafterMountDoc(
  cache: Map<string, DrafterSessionEntry>,
  loaded: { forId: string; doc: JSONContent | null } | null,
  activeId: string | null,
): { doc: JSONContent | null } | null {
  if (!activeId) return null;
  const entry = cache.get(activeId);
  if (entry) return { doc: entry.json };
  // No flush this session yet: the load effect's copy is the only one there is,
  // and it only counts when it is tagged for THIS document.
  if (loaded && loaded.forId === activeId) return { doc: loaded.doc };
  return null;
}
