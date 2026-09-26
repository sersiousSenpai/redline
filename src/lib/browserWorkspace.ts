// SPDX-License-Identifier: Apache-2.0
import { invoke } from "@tauri-apps/api/core";
import type { BrowserLayout } from "./browserLayout";
export interface SavedBrowserWorkspace {
  tabs: { id?: string | null; url: string; title?: string; browseId?: string | null }[];
  layout?: BrowserLayout;
  /** A mosaic's definition (see browserMosaics). The backend keeps these when a save omits them. */
  name?: string;
  grid?: { rows: number; cols: number };
  cells?: { browseId: string; url: string; label?: string }[];
  revision: number;
}
/** Application-lifetime serialized persistence, independent of React effects. */
const revisions = new Map<string, number>();
const externalChanges = new Map<string, number>();
const writes = new Map<string, Promise<unknown>>();
export async function loadBrowserWorkspace(workspaceId: string): Promise<SavedBrowserWorkspace | null> {
  await writes.get(workspaceId)?.catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = externalChanges.get(workspaceId) ?? 0;
    const saved = await invoke<SavedBrowserWorkspace | null>("browser_workspace_read", { workspaceId });
    if (generation !== (externalChanges.get(workspaceId) ?? 0)) continue;
    revisions.set(workspaceId, saved?.revision ?? 0);
    return saved;
  }
  throw new Error("The workspace changed while loading; retry to load its latest pages.");
}
export function saveBrowserWorkspace(workspaceId: string, value: Omit<SavedBrowserWorkspace, "revision">): Promise<void> {
  const generation = externalChanges.get(workspaceId) ?? 0;
  const next = (writes.get(workspaceId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!revisions.has(workspaceId)) {
      const saved = await invoke<SavedBrowserWorkspace | null>("browser_workspace_read", { workspaceId });
      revisions.set(workspaceId, saved?.revision ?? 0);
    }
    if (generation !== (externalChanges.get(workspaceId) ?? 0)) throw new Error("The workspace changed before this save; newer state has been preserved.");
    const result = await invoke<SavedBrowserWorkspace>("browser_workspace_write", { workspaceId, value, expectedRevision: revisions.get(workspaceId) });
    revisions.set(workspaceId, Math.max(revisions.get(workspaceId) ?? 0, result.revision));
  });
  writes.set(workspaceId, next);
  return next;
}

export function noteWorkspaceRevision(workspaceId: string, revision: number) {
  if (!Number.isSafeInteger(revision) || revision <= (revisions.get(workspaceId) ?? 0)) return;
  revisions.set(workspaceId, revision);
  externalChanges.set(workspaceId, (externalChanges.get(workspaceId) ?? 0) + 1);
}

/** A deleted workspace's cached revision must not gate a later write to its ID. */
export function forgetBrowserWorkspace(workspaceId: string) {
  revisions.delete(workspaceId);
  externalChanges.set(workspaceId, (externalChanges.get(workspaceId) ?? 0) + 1);
}
