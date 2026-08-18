// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The main pane shows exactly ONE surface at a time — the four independent
// open/closed booleans it replaced could disagree (stale localStorage made
// panes tile unpredictably), so the surface is a single value and illegal
// states are unrepresentable. Tiling is a separate, explicit choice: `docPinned`
// keeps the document alongside whichever non-document surface is selected.
export type MainSurface =
  | "document"
  | "browser"
  | "drafter"
  | "review"
  | "servers"
  | "memory"
  | "runs";

/** A surface id as MANIFEST data carries it (workspace.json, a harness
 *  pack): the known union, plus any string a future manifest names. Widened
 *  where data flows in — dispatch is a lenient Record and header composition
 *  filters to what this build renders, so an unknown id degrades to nothing
 *  instead of failing a closed union. State stays `MainSurface`: every
 *  surface Redline can actually SHOW is compiled in (one codebase — a
 *  harness composes surfaces, it never adds code). */
export type SurfaceId = MainSurface | (string & {});

export const MAIN_SURFACE_KEY = "redline.mainSurface";
export const DOC_PINNED_KEY = "redline.doc.pinned";

// The legacy per-pane keys this model replaces (pre-07/09 builds).
const LEGACY_DOC_KEY = "redline.doc.open";
const LEGACY_BROWSER_KEY = "redline.browser.open";
const LEGACY_DRAFTER_KEY = "redline.drafter.open";
const LEGACY_REVIEW_KEY = "redline.review.open";

/** Which single surface a legacy boolean trio denotes. Precedence mirrors
 *  deriveActiveSurface: review > drafter > browser (they were nominally
 *  mutually exclusive, but stale storage could hold several true at once). */
export function legacyMainSurface(
  reviewOpen: boolean,
  drafterOpen: boolean,
  browserOpen: boolean,
): MainSurface {
  if (reviewOpen) return "review";
  if (drafterOpen) return "drafter";
  if (browserOpen) return "browser";
  return "document";
}

function readLegacyBool(storage: Storage, key: string): boolean {
  try {
    return JSON.parse(storage.getItem(key) ?? "false") === true;
  } catch {
    return false;
  }
}

/** One-time upgrade of the persisted pane state: when `redline.mainSurface`
 *  is absent, derive it (and `redline.doc.pinned` — legacy doc-open users kept
 *  the document tiled, so they keep their habit) from the legacy keys, then
 *  delete the legacy keys. Idempotent: a present mainSurface key means the
 *  migration already ran (or a fresh install never needs it). */
export function migrateMainSurfaceOnce(storage: Storage): void {
  try {
    if (storage.getItem(MAIN_SURFACE_KEY) != null) return;
    const legacySeen =
      storage.getItem(LEGACY_DOC_KEY) != null ||
      storage.getItem(LEGACY_BROWSER_KEY) != null ||
      storage.getItem(LEGACY_DRAFTER_KEY) != null ||
      storage.getItem(LEGACY_REVIEW_KEY) != null;
    if (!legacySeen) return; // fresh install — defaults apply
    const surface = legacyMainSurface(
      readLegacyBool(storage, LEGACY_REVIEW_KEY),
      readLegacyBool(storage, LEGACY_DRAFTER_KEY),
      readLegacyBool(storage, LEGACY_BROWSER_KEY),
    );
    const docPinned =
      surface !== "document" && readLegacyBool(storage, LEGACY_DOC_KEY);
    storage.setItem(MAIN_SURFACE_KEY, JSON.stringify(surface));
    storage.setItem(DOC_PINNED_KEY, JSON.stringify(docPinned));
    storage.removeItem(LEGACY_DOC_KEY);
    storage.removeItem(LEGACY_BROWSER_KEY);
    storage.removeItem(LEGACY_DRAFTER_KEY);
    storage.removeItem(LEGACY_REVIEW_KEY);
  } catch {
    /* storage unavailable — in-memory defaults apply */
  }
}
