// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it, vi } from "vitest";

import { getNotifyPrefs, NOTIFY_PREF_KEYS, resetNotifyPrefsCache, setNotifyPref, subscribeNotifyPrefs } from "./notifyPrefs";

afterEach(() => {
  localStorage.clear();
  resetNotifyPrefsCache();
});

describe("notify prefs", () => {
  it("both kinds are on until turned off", () => {
    expect(getNotifyPrefs()).toEqual({ waiting: true, finished: true });
  });

  it("a toggle persists, tells subscribers, and keeps the other kind", () => {
    const heard = vi.fn();
    const off = subscribeNotifyPrefs(heard);
    const before = getNotifyPrefs();
    setNotifyPref("finished", false);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(getNotifyPrefs()).not.toBe(before);
    expect(getNotifyPrefs()).toEqual({ waiting: true, finished: false });
    expect(localStorage.getItem(NOTIFY_PREF_KEYS.finished)).toBe("false");
    resetNotifyPrefsCache();
    expect(getNotifyPrefs()).toEqual({ waiting: true, finished: false });
    off();
  });

  it("the snapshot is stable between changes", () => {
    expect(getNotifyPrefs()).toBe(getNotifyPrefs());
  });
});
