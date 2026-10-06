// SPDX-License-Identifier: Apache-2.0
// The Code Review surface's pose: the annotatable diff review ("review") or the
// full repository client ("repository"). Remembered in localStorage and synced
// through the ui-pref table so a fresh webview opens where the user left it.
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { reconcilePick } from "../theme/prefsSync";
export type ReviewPose = "review" | "repository";
const key = "redline.reviewPose";
const listeners = new Set<() => void>();
let initialized = false,
  revision = 0;

/** Any stored value that is not "repository" — including the retired
 *  "guided"/"expert" poses — reads as the review pose. */
export function normalizeReviewPose(value: unknown): ReviewPose {
  return value === "repository" ? "repository" : "review";
}

let pose: ReviewPose = (() => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return "review";
    const value = normalizeReviewPose(JSON.parse(raw));
    // Rewrite a retired value so the ui-pref reconcile sees a valid name.
    if (JSON.parse(raw) !== value) localStorage.setItem(key, JSON.stringify(value));
    return value;
  } catch {
    return "review";
  }
})();
function apply(value: ReviewPose) {
  pose = value;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* in-memory is still usable */
  }
  listeners.forEach((fn) => fn());
}
export function setReviewPose(value: ReviewPose) {
  if (value === pose) return;
  revision++;
  apply(value);
  void invoke("set_ui_pref", { key: "reviewPose", value }).catch(() => {});
}
export function useReviewPose(
  hydrate = true,
): [ReviewPose, typeof setReviewPose] {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => pose,
  );
  useEffect(() => {
    if (!hydrate || initialized) return;
    initialized = true;
    const began = revision;
    void invoke<{ reviewPose?: string | null } | null>("get_ui_prefs")
      .then((prefs) => {
        if (began !== revision) return;
        let explicit = false;
        try {
          explicit = localStorage.getItem(key) != null;
        } catch {
          /* no local cache */
        }
        // A retired DB value ("guided"/"expert") migrates to "review".
        const db = prefs?.reviewPose == null ? prefs?.reviewPose : normalizeReviewPose(prefs.reviewPose);
        const decision = reconcilePick({
          db,
          local: pose,
          hasExplicitLocal: explicit,
          isValid: (name) => name === "review" || name === "repository",
        });
        if (decision.apply) apply(normalizeReviewPose(decision.apply));
        const writeDb = decision.writeDb ?? (prefs?.reviewPose != null && prefs.reviewPose !== db ? db : null);
        if (writeDb)
          void invoke("set_ui_pref", {
            key: "reviewPose",
            value: writeDb,
          }).catch(() => {});
      })
      .catch(() => {
        initialized = false;
      });
  }, [hydrate]);
  return [value, setReviewPose];
}

/** Test seam: forget the module-level state so each test starts cold. */
export function __resetReviewPoseForTest() {
  initialized = false;
  revision = 0;
  try {
    pose = normalizeReviewPose(JSON.parse(localStorage.getItem(key) ?? '"review"'));
  } catch {
    pose = "review";
  }
}
