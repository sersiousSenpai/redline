// SPDX-License-Identifier: Apache-2.0
import { invoke } from "@tauri-apps/api/core";
import type { BrowseListView } from "../types";
import { cartKey } from "./browseList";

const pending = new Map<string, Promise<BrowseListView>>();

/** Only create absent carts. Starting an existing list would retitle it. */
export function ensureCart(workspaceKey: string): Promise<BrowseListView> {
  const browseId = cartKey(workspaceKey);
  const existing = pending.get(browseId);
  if (existing) return existing;
  const request = invoke<BrowseListView | null>("browse_list_get", { browseId })
    .then(view => view ?? invoke<BrowseListView>("browse_list_start", { browseId, template: "cart", title: "Cart" }))
    .finally(() => pending.delete(browseId));
  pending.set(browseId, request);
  return request;
}
