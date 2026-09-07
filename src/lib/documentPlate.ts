// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The document plate has three identities, and until now they were only ever
// spelled out inline — `sidebarTab.kind === "folder" && activeFile` appears at
// half a dozen call sites in App.tsx, each one re-deriving "is this the file
// viewer?" from scratch, and the door/plan split was implicit in whether a
// session happened to be ready. That is three surfaces wearing one name.
//
// Naming them here does NOT split the surface: `mainSurface` stays a single
// value and "document" stays one of its members. It gives the plate's own
// switch a tested vocabulary, which is what the conversation dock needs — a
// file viewer has no plan to discuss, and the Front Door has no document at
// all, so the two of them are not the same context as an open plan.

/** Which of the document plate's three faces is showing.
 *  - `file` — the folder explorer's read-only viewer (a path, not a document).
 *  - `plan` — a plan review session: the document proper.
 *  - `door` — the Front Door: no document is open yet. */
export type DocumentPlateMode = "door" | "plan" | "file";

/** The sidebar's current tab, structurally — `useFolderWorkspaces`' SidebarTab
 *  without the import, so this stays a leaf of the module graph. */
export type PlateSidebarTab =
  | { kind: "sessions" }
  | { kind: "folder"; id: string };

/**
 * Precedence, highest first:
 *
 * 1. **file** — a folder tab with a file open. The viewer replaces the document
 *    body outright, so it wins over any plan session that happens to be
 *    selected underneath (returning to the sessions tab restores it).
 * 2. **plan** — a plan session is selected. Note this is the SELECTED session,
 *    not a ready one: a plan that is still loading is still the plate's
 *    identity, which is why the door does not flash up mid-load.
 * 3. **door** — nothing is open. The Front Door is the empty state, not a
 *    fourth surface.
 */
export function documentPlateMode(
  sidebarTab: PlateSidebarTab,
  activeId: string | null,
  activeFile: string | null,
): DocumentPlateMode {
  if (sidebarTab.kind === "folder" && activeFile) return "file";
  if (activeId) return "plan";
  return "door";
}
