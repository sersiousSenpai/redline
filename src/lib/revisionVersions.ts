// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { RevisionSummary } from "../types";

/** Minimal shape these helpers need — satisfied by both the lightweight
 *  `RevisionSummary` (sidebar) and the full `Revision` (document pane). */
type VersionedRevision = Pick<RevisionSummary, "versionNumber" | "restored">;

/** Per-row display info derived from the oldest-first revisions array.
 *  A restore re-uses the current substantive version ("vN restored") and does
 *  not advance the count, so a genuine later revision picks up the next number.
 *  Keyed by the stable internal `versionNumber` (used everywhere for identity).*/
export function computeRevisionDisplay(
  revisions: VersionedRevision[],
): Map<number, { displayVersion: number; isLatest: boolean }> {
  const out = new Map<number, { displayVersion: number; isLatest: boolean }>();
  let substantive = 0;
  revisions.forEach((r, idx) => {
    let displayVersion: number;
    if (r.restored) {
      displayVersion = substantive || 1;
    } else {
      substantive += 1;
      displayVersion = substantive;
    }
    out.set(r.versionNumber, {
      displayVersion,
      isLatest: idx === revisions.length - 1,
    });
  });
  return out;
}

/** The session's latest *substantive* version for a header/badge — restores
 *  don't count. Falls back to the raw latest when there are no revisions. */
export function latestDisplayVersion(
  revisions: VersionedRevision[],
  fallback: number,
): number {
  const n = revisions.reduce((acc, r) => (r.restored ? acc : acc + 1), 0);
  return n || fallback;
}
