// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The adapter: App's old vocabulary read off the workbench state, so its
// read sites (`mainSurface`, `docPinned`, `activeId`, `activeFile`) keep
// their value types while the two models coexist, and its one writer
// (`selectSurface`) has a kind to dispatch. Pure; deleted in W6 with
// `mainSurface.ts` and `documentPlate.ts`.

import type { MainSurface } from "../lib/mainSurface";
import { activeTabOf, isDocumentKind, paneIdsOf, sessionIdOf, type AnyPane, type PaneKind, type SessionKey, type WorkbenchState } from "./model";

export interface LegacyView {
  /** The tab's non-document pane kind. It does NOT follow focus: clicking
   *  the plan half of a plan + browser tab must not hide the webview. */
  mainSurface: MainSurface;
  /** A document face (door, plan, file) shares the tab with a surface. */
  docPinned: boolean;
  /** The selected plan session; null on Home and during a launch. */
  activeId: string | null;
  /** The focused file pane's path, else the tab's first file, else null. */
  activeFile: string | null;
  /** New: what has focus, and everything the active tab shows. */
  focusedKind: PaneKind | null;
  visibleKinds: PaneKind[];
}

/** A pane App's `mainSurface` would call a surface, or null for the plate's
 *  faces, a terminal wall and the session's own agent chat (the dock's). */
export function surfaceOf(pane: AnyPane): MainSurface | null {
  if (isDocumentKind(pane.kind) || pane.kind === "terminals") return null;
  if (pane.kind === "chat") return pane.data.source === "companion" ? "chat" : null;
  // Narrowed by hand: the compiler cannot subtract the kinds excluded above.
  return pane.kind as Exclude<PaneKind, "door" | "plan" | "file" | "terminals" | "chat">;
}

export function legacyView(state: WorkbenchState): LegacyView {
  const set = state.sets[state.activeKey];
  const tab = set ? activeTabOf(set) : null;
  const panes = tab && set ? paneIdsOf(tab.root).map((id) => set.panes[id]).filter((p): p is AnyPane => Boolean(p)) : [];
  const focused = tab && set ? (set.panes[tab.focusedPaneId] ?? null) : null;
  let mainSurface: MainSurface = "document";
  for (const pane of panes) {
    const s = surfaceOf(pane);
    if (s) {
      mainSurface = s;
      break;
    }
  }
  const hasDocument = panes.some((p) => isDocumentKind(p.kind));
  const files = panes.filter((p): p is Extract<AnyPane, { kind: "file" }> => p.kind === "file");
  const focusedFile = focused && focused.kind === "file" ? focused : files[0];
  const visibleKinds: PaneKind[] = [];
  for (const p of panes) if (!visibleKinds.includes(p.kind)) visibleKinds.push(p.kind);
  return {
    mainSurface,
    docPinned: mainSurface !== "document" && hasDocument,
    activeId: sessionIdOf(state.activeKey),
    activeFile: focusedFile?.data.path ?? null,
    focusedKind: focused?.kind ?? null,
    visibleKinds,
  };
}

/** The pane kind `selectSurface(surface)` means in `key`: "document" is the
 *  session's plan, or the door when there is no session. */
export function kindForSurface(surface: MainSurface, key: SessionKey): PaneKind {
  if (surface === "document") return sessionIdOf(key) ? "plan" : "door";
  return surface;
}
