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
