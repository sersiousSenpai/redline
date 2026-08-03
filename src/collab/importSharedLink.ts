// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Land a `redline://…#RLS1…` deep link as a full native review session.
 *
 * The viewer's "Open in Redline" link carries the same self-contained
 * encrypted snapshot token the browser preview used. The OS routes it to this
 * app; we decrypt client-side (the key rides the fragment, never a server) and
 * hand the plan markdown — sidecars intact — to the `import_shared_plan`
 * command, which reconstructs an identical `sections`/`blockId` tree so the
 * recipient gets full track-changes + discussion, not just the preview.
 */
import { invoke } from "@tauri-apps/api/core";

import { decodeSnapshot, tokenFromLink } from "./snapshot";

/** Decode one deep-link URL and import it. Returns the new session id, or
 *  null when the URL carries no valid snapshot (so a stray `redline://` open
 *  is a quiet no-op rather than an error). */
export async function importSharedPlanFromUrl(
  url: string,
): Promise<string | null> {
  const token = tokenFromLink(url);
  if (!token) return null;
  const payload = await decodeSnapshot(token);
  if (!payload) return null;
  return invoke<string>("import_shared_plan", {
    markdown: payload.markdown,
    projectName: payload.projectName ?? null,
  });
}
