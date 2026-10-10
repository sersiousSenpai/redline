// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  focused: true,
  attention: vi.fn(async (_type: unknown) => {}),
  setFocus: vi.fn(async () => {}),
  unminimize: vi.fn(async () => {}),
  notify: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  UserAttentionType: { Critical: 1, Informational: 2 },
  getCurrentWindow: () => ({
    isFocused: async () => mocks.focused,
    requestUserAttention: mocks.attention,
    setFocus: mocks.setFocus,
    unminimize: mocks.unminimize,
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: mocks.notify,
}));

import { noticeWhenAway } from "./osNotice";

beforeEach(() => {
  mocks.attention.mockClear();
  mocks.notify.mockClear();
  mocks.setFocus.mockClear();
  mocks.unminimize.mockClear();
});

describe("news for someone in another app", () => {
  it("says nothing through the OS while Redline is the window in front", async () => {
    mocks.focused = true;
    await noticeWhenAway("Review ready", "An agent is waiting.");
    expect(mocks.attention).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("from another app: one Dock bounce and a notification, never the window brought forward", async () => {
    mocks.focused = false;
    await noticeWhenAway("Plan v3 ready", "Auto-approving in 20s unless you open it in Redline.");
    expect(mocks.attention).toHaveBeenCalledWith(2);
    expect(mocks.notify).toHaveBeenCalledWith({ title: "Plan v3 ready", body: "Auto-approving in 20s unless you open it in Redline." });
    expect(mocks.setFocus).not.toHaveBeenCalled();
    expect(mocks.unminimize).not.toHaveBeenCalled();
  });
});
