// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * The room's meta map: owner-published session facts a collaborator can't
 * derive locally (they have no backend session). Its load-bearing field is
 * `currentVersion` — the revision-rollover handoff: when the owner's plan
 * moves to a new revision (new room), the owner bumps `currentVersion` into
 * the OLD room's meta as the forwarding address, and observers re-point
 * their provider/editor to the new room and hydrate from the mesh.
 */
import type * as Y from "yjs";

export const META_FIELD = "meta";

export interface CollabMeta {
  /** Latest revision number — the room a collaborator should be in. */
  currentVersion?: number;
  /** The review thread's base revision (part of the room name triple). */
  threadStart?: number;
  ownerName?: string;
  projectName?: string;
  /** Session status as the owner last published it (display only). */
  status?: string;
}

const META_KEYS: (keyof CollabMeta)[] = [
  "currentVersion",
  "threadStart",
  "ownerName",
  "projectName",
  "status",
];

function metaMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap<unknown>(META_FIELD);
}

/** Idempotent per-key publish — unchanged values emit no ops, so the owner
 *  can re-publish on every reload. Returns the op count. */
export function publishMeta(ydoc: Y.Doc, meta: CollabMeta): number {
  const map = metaMap(ydoc);
  let ops = 0;
  ydoc.transact(() => {
    for (const key of META_KEYS) {
      const value = meta[key];
      if (value === undefined) continue;
      if (map.get(key) === value) continue;
      map.set(key, value);
      ops++;
    }
  });
  return ops;
}

export function readMeta(ydoc: Y.Doc): CollabMeta {
  const map = metaMap(ydoc);
  const out: CollabMeta = {};
  for (const key of META_KEYS) {
    const value = map.get(key);
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export function observeMeta(ydoc: Y.Doc, cb: () => void): () => void {
  const map = metaMap(ydoc);
  const handler = () => cb();
  map.observe(handler);
  return () => map.unobserve(handler);
}
