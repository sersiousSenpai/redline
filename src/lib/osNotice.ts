// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

// Telling someone in another app that Redline has news: an OS notification,
// and a bounce of the Dock icon. Never by un-minimizing the window or
// bringing it to the front — going there is theirs to do. Loaded at the first
// notice, so nothing on the boot path pays for it.

/** Permission is asked once per launch, at the first notification — never at
 *  boot, and never again after a "no". */
let permission: Promise<boolean> | null = null;

export async function notify(title: string, body: string): Promise<void> {
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    permission ??= (async () =>
      (await plugin.isPermissionGranted()) ||
      (await plugin.requestPermission()) === "granted")();
    if (await permission) plugin.sendNotification({ title, body });
  } catch {
    // No plugin or no permission system (tests, a stripped build): stay
    // quiet, and ask again next time rather than caching the failure.
    permission = null;
  }
}

/** News that waits for the user — an agent's review request, a run's report,
 *  a plan's decision countdown. Said by the OS only while Redline's window is
 *  not the one in front; in front, the app's own notice is enough. Asks the
 *  window, not `document.hasFocus()`, which is false while the caret sits in
 *  one of Redline's own browser pages. */
export async function noticeWhenAway(title: string, body: string): Promise<void> {
  const win = getCurrentWindow();
  if (await win.isFocused().catch(() => true)) return;
  void win.requestUserAttention(UserAttentionType.Informational).catch(() => {});
  await notify(title, body);
}
