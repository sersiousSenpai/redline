// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Pure logic for the folder-viewer's CodeMirror editor, kept out of the
// editor chunk's React component so it's unit-testable without a DOM view.

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

import type { FileContent } from "../types";

/** The language registry entry for a file path (metadata only — calling
 *  `.load()` on the result does the actual dynamic grammar import, which Vite
 *  splits into a per-language chunk). Null when no grammar matches. */
export function languageForPath(path: string): LanguageDescription | null {
  const idx = path.lastIndexOf("/");
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  return LanguageDescription.matchFilename(languages, name);
}

/** Load everything the editor needs to mount already-highlighted: the raw
 *  text and the grammar, in parallel. A grammar that fails to load resolves to
 *  `null` — the editor still opens, plain — instead of today's alternative of
 *  an unhandled rejection leaving the file permanently uncolored. Read
 *  failures and non-editable files (too large / binary) reject: the caller
 *  stays in the read view and surfaces the message. */
export async function prepareEditContent<L>(
  read: () => Promise<FileContent>,
  loadLanguage: (() => Promise<L>) | null,
): Promise<{ content: string; language: L | null }> {
  const [f, language] = await Promise.all([
    read(),
    loadLanguage ? loadLanguage().catch(() => null) : Promise.resolve(null),
  ]);
  if (f.tooLarge) throw new Error("File is too large to edit (2 MB cap).");
  if (f.isBinary || f.content == null) throw new Error("Binary file — not editable.");
  return { content: f.content, language };
}

/** What to do when the file changes on disk under an open editor. */
export type DiskChangeResolution = "ignore" | "reload" | "conflict";

/** Decide how an fs-watch event lands in the editor:
 *  - the disk now holds exactly what we last saved → our own save echo
 *    (or a no-op write): ignore;
 *  - the buffer is clean → silently take the disk content (the same
 *    live-reload contract as the read-only CodeView);
 *  - the buffer is dirty → surface the conflict banner (Reload / Keep
 *    editing — Save overwrites; last-writer-wins, no merge). */
export function resolveDiskChange(i: {
  dirty: boolean;
  disk: string;
  saved: string;
}): DiskChangeResolution {
  if (i.disk === i.saved) return "ignore";
  return i.dirty ? "conflict" : "reload";
}

/** The ⌘S binding: runs `save` and claims the key (returning true is what
 *  stops WebKit's own "save page" dialog). Wrapped `Prec.high` by the
 *  editor so it wins over any default binding. */
export function saveKeyBinding(save: () => void): {
  key: string;
  run: () => boolean;
} {
  return {
    key: "Mod-s",
    run: () => {
      save();
      return true;
    },
  };
}
