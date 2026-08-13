// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/**
 * Pin the open session to the top of the sidebar list, leaving every other
 * row in the order it arrived (the backend's updated_at-desc sort — that sort
 * stays untouched; this is presentation only, the house pinned-first idiom,
 * cf. buildTree in classTree.ts). Returns the SAME array reference when there
 * is nothing to move — `activeId` null, already first, or matching no row
 * (a joined-room key has no local summary) — so referential-equality checks
 * downstream keep working. Never mutates the input.
 */
export function orderSessions<T extends { sessionId: string }>(
  sessions: T[],
  activeId: string | null,
): T[] {
  if (!activeId) return sessions;
  const idx = sessions.findIndex((s) => s.sessionId === activeId);
  if (idx <= 0) return sessions;
  return [
    sessions[idx],
    ...sessions.slice(0, idx),
    ...sessions.slice(idx + 1),
  ];
}
