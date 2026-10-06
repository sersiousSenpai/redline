// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useState } from "react";
export type DiscussMode = "report" | "conversation";
export function useDiscussMode(sessionId: string, commentId: string) {
  const key = `redline.sidecarMode.${sessionId}.${commentId}`;
  const read = (): DiscussMode => {
    try { return localStorage.getItem(key) === "report" ? "report" : "conversation"; }
    catch { return "conversation"; }
  };
  const [stored, setStored] = useState(() => ({ key, mode: read() }));
  const mode = stored.key === key ? stored.mode : read();
  const setMode = useCallback((next: DiscussMode) => {
    setStored({ key, mode: next });
    try { localStorage.setItem(key, next); } catch { /* Private/blocked storage. */ }
  }, [key]);
  return [mode, setMode] as const;
}
