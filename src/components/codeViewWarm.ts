// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** The CodeView warm, in its own module so the folder explorer (FileTree,
 *  static in App's sidebar) can warm the chunk without statically importing
 *  FileViewer — which would hold the viewer on the boot path now that App
 *  loads it lazily. Dynamic imports of one module dedupe by identity, so this
 *  and FileViewer's `lazy()` share a single fetch. */
export const codeViewImport = () => import("./CodeView");

let codeViewPreloaded: Promise<unknown> | null = null;
/** Warm the CodeView chunk ahead of the first open. Idempotent. */
export function preloadCodeView(): void {
  if (!codeViewPreloaded) codeViewPreloaded = codeViewImport();
}
