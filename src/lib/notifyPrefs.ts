// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Which agent news reaches you as an OS notification: "waiting" (blocked on
// you) and "finished" (its turn ended), each on unless turned off in the
// notifications settings. The settings row writes, `useAttentionAlerts`
// reads at the moment it would notify, so neither threads it through App.

import type { AlertKind } from "./attentionAlerts";

export type NotifyPrefs = Readonly<Record<AlertKind, boolean>>;

export const NOTIFY_PREF_KEYS: Readonly<Record<AlertKind, string>> = {
  waiting: "redline.notify.waiting",
  finished: "redline.notify.finished",
};

const DEFAULTS: NotifyPrefs = { waiting: true, finished: true };

let cached: NotifyPrefs | null = null;
const listeners = new Set<() => void>();

function read(kind: AlertKind): boolean {
  try {
    const raw = localStorage.getItem(NOTIFY_PREF_KEYS[kind]);
    if (raw === "false") return false;
    if (raw === "true") return true;
  } catch {
    /* no storage: the default */
  }
  return DEFAULTS[kind];
}

/** The current prefs; the same object until one changes. */
export function getNotifyPrefs(): NotifyPrefs {
  cached ??= { waiting: read("waiting"), finished: read("finished") };
  return cached;
}

export function setNotifyPref(kind: AlertKind, on: boolean): void {
  try {
    localStorage.setItem(NOTIFY_PREF_KEYS[kind], on ? "true" : "false");
  } catch {
    /* kept for this launch only */
  }
  cached = { ...getNotifyPrefs(), [kind]: on };
  for (const listener of Array.from(listeners)) listener();
}

export function subscribeNotifyPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests: forget the cached read. */
export function resetNotifyPrefsCache(): void {
  cached = null;
}
