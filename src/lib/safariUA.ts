// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** The Safari UA both native-webview owners present. Lives in its own module
 *  so the thumb-capture hook (static on the boot path via ServersPane) can
 *  share it without statically importing BrowserPane — which would drag the
 *  whole 109 KB pane back into the boot closure the moment it went lazy. */
export const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
