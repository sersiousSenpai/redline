// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { prosemirrorJSONToYDoc } from "y-prosemirror";

import { planMarkdownToDoc } from "../markdown";
import { planSchema } from "../markdown/schema";

/** The Y.XmlFragment field the Collaboration extension binds to — must match
 *  `@tiptap/extension-collaboration`'s default (`field: 'default'`). */
const PLAN_FRAGMENT = "default";

/** IndexedDB database-name prefix for persisted plan Y.Docs. The full name is
 *  `redline-plan-ydoc:<revisionKey>` where `revisionKey` is
 *  `<sessionId>:<threadStart>:<version>` — so all of a session's entries share
 *  the `redline-plan-ydoc:<sessionId>:` prefix and can be swept together. */
const DB_PREFIX = "redline-plan-ydoc:";

/** True once the doc carries content — i.e. it was seeded (or restored from a
 *  persisted copy that was itself seeded). */
export function isPlanYDocSeeded(ydoc: Y.Doc): boolean {
  return ydoc.getXmlFragment(PLAN_FRAGMENT).length > 0;
}

/**
 * Seed an EMPTY per-revision Y.Doc from the revision's sidecar-augmented
 * markdown. Returns false (and leaves the doc untouched) when the doc already
 * has content — the reconciliation rule for crash recovery: a persisted copy
 * of the *same* revision wins, because it is a superset of this exact seed
 * plus any uncommitted edits. Seeding is not deterministic across calls (Yjs
 * client ids differ), so seeding twice would duplicate content; the guard is
 * load-bearing, not an optimization.
 */
export function seedPlanYDocIfEmpty(ydoc: Y.Doc, markdown: string): boolean {
  if (isPlanYDocSeeded(ydoc)) return false;
  const seeded = prosemirrorJSONToYDoc(
    planSchema(),
    planMarkdownToDoc(markdown).toJSON(),
    PLAN_FRAGMENT,
  );
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seeded));
  return true;
}

export interface PlanYDocPersistence {
  /** Resolves once any persisted content has been applied to the Y.Doc —
   *  only after this is it safe to decide whether to seed. */
  whenSynced: Promise<void>;
  destroy: () => Promise<void>;
}

/**
 * Crash-recovery persistence: mirror the revision's Y.Doc into IndexedDB,
 * keyed by session + revision (via `revisionKey`) so plan versions never
 * collide. Returns null where IndexedDB is unavailable (jsdom tests) — the
 * editor then runs in-memory only, exactly as before M2.
 */
export function persistPlanYDoc(
  revisionKey: string,
  ydoc: Y.Doc,
): PlanYDocPersistence | null {
  if (typeof indexedDB === "undefined") return null;
  const provider = new IndexeddbPersistence(DB_PREFIX + revisionKey, ydoc);
  return {
    whenSynced: provider.whenSynced.then(() => undefined),
    destroy: () => provider.destroy(),
  };
}

/**
 * Delete a session's persisted Y.Docs, except (optionally) the revision that
 * is currently live. Two callers:
 *  - PlanEditor after hydrating a revision — sweeps superseded revisions, so
 *    a stale local copy can never be resurrected against a newer plan.
 *  - App on session delete — sweeps everything for the session.
 * Best-effort: `indexedDB.databases()` is feature-detected, and a delete
 * blocked by a still-open connection simply completes once it closes.
 */
export async function clearStalePlanYDocs(
  sessionId: string,
  keepRevisionKey?: string,
): Promise<void> {
  if (
    typeof indexedDB === "undefined" ||
    typeof indexedDB.databases !== "function"
  ) {
    return;
  }
  const prefix = `${DB_PREFIX}${sessionId}:`;
  const keep = keepRevisionKey ? DB_PREFIX + keepRevisionKey : null;
  let dbs: { name?: string }[] = [];
  try {
    dbs = await indexedDB.databases();
  } catch {
    return;
  }
  for (const db of dbs) {
    if (!db.name || !db.name.startsWith(prefix) || db.name === keep) continue;
    indexedDB.deleteDatabase(db.name);
  }
}
