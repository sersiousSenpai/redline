// SPDX-License-Identifier: Apache-2.0
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { reconcilePick } from "../theme/prefsSync";
export type ReviewPose = "guided" | "expert";
const key = "redline.reviewPose";
const listeners = new Set<() => void>();
let initialized = false,
  revision = 0;
let pose: ReviewPose = (() => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '"expert"') === "guided"
      ? "guided"
      : "expert";
  } catch {
    return "expert";
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
    void invoke<{ reviewPose?: string | null }>("get_ui_prefs")
      .then((prefs) => {
        if (began !== revision) return;
        let explicit = false;
        try {
          explicit = localStorage.getItem(key) != null;
        } catch {
          /* no local cache */
        }
        const decision = reconcilePick({
          db: prefs.reviewPose,
          local: pose,
          hasExplicitLocal: explicit,
          isValid: (name) => name === "guided" || name === "expert",
        });
        if (decision.apply) apply(decision.apply as ReviewPose);
        if (decision.writeDb)
          void invoke("set_ui_pref", {
            key: "reviewPose",
            value: decision.writeDb,
          }).catch(() => {});
      })
      .catch(() => {
        initialized = false;
      });
  }, [hydrate]);
  return [value, setReviewPose];
}
