// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useState } from "react";

/** Which of a comment's two discussion views is showing: the report — the
 *  structured answer the thread exists for — or the quick chat beside it. */
export type SidecarView = "report" | "chat";

/** The per-comment view, remembered across remounts and relaunches. Only
 *  "chat" is ever stored as itself: anything else, including the retired
 *  "conversation" mode, reads as the report. */
export function useSidecarView(sessionId: string, commentId: string) {
  const key = `redline.sidecarView.${sessionId}.${commentId}`;
  const read = (): SidecarView => {
    try { return localStorage.getItem(key) === "chat" ? "chat" : "report"; }
    catch { return "report"; }
  };
  const [stored, setStored] = useState(() => ({ key, view: read() }));
  const view = stored.key === key ? stored.view : read();
  const setView = useCallback((next: SidecarView) => {
    setStored({ key, view: next });
    try { localStorage.setItem(key, next); } catch { /* Private/blocked storage. */ }
  }, [key]);
  return [view, setView] as const;
}
