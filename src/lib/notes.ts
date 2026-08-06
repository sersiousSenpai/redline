// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Pure vocabulary behind user notes and stars (Second Brain P3): the wire
// shapes of the `memory_note_*` commands and the act-builders the surface
// sends. The backend enforces one act per call (each act appends exactly one
// `note` ledger event); the builders here make a malformed two-act payload
// unrepresentable at the call site. Dependency-free, side-effect-free — the
// `timeline.ts` discipline.

/** Mirror of `context::UserNote` (camelCase over the wire). */
export interface UserNote {
  id: number;
  /** Latest `note` ledger event seq that touched this row. */
  seq: number | null;
  /** `ledger_event | class_node | session | none` (standalone thought). */
  targetKind: string;
  targetId: string | null;
  text: string;
  starred: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Mirror of `context::NoteWrite` — the `memory_note_write` payload. */
export interface NoteWrite {
  noteId?: number;
  targetKind?: string;
  targetId?: string;
  text?: string;
  starred?: boolean;
}

/** One act — set a note's words or its star — never both in one payload. */
export type NoteAct = { text: string } | { starred: boolean };

/** The act on a timeline event: annotate / star the row with ledger seq `seq`. */
export function noteOnEvent(seq: number, act: NoteAct): NoteWrite {
  return { targetKind: "ledger_event", targetId: String(seq), ...act };
}

/** A standalone thought: create (`noteId` absent) or edit one row's words. */
export function standaloneNote(text: string, noteId?: number): NoteWrite {
  return noteId != null ? { noteId, text } : { text };
}

/** Human label for what a note row annotates. */
export function noteTargetLabel(n: Pick<UserNote, "targetKind" | "targetId">): string {
  switch (n.targetKind) {
    case "none":
      return "standalone";
    case "ledger_event":
      return `on event #${n.targetId ?? "?"}`;
    case "class_node":
      return `on class ${n.targetId ?? "?"}`;
    case "session":
      return `on session ${(n.targetId ?? "").slice(0, 8) || "?"}`;
    default:
      return `on ${n.targetKind} ${n.targetId ?? ""}`.trim();
  }
}
