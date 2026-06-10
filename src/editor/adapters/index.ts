// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Node as PMNode } from "@tiptap/pm/model";

import type { Comment } from "../../types";
import { planDocToMarkdown } from "../markdown";

/**
 * The format socket. The internal document model is the product; every file
 * format is a removable adapter behind this seam. An adapter consumes the
 * internal model — a ProseMirror doc plus its block-anchor map and review
 * comments — and nothing outside an adapter's own module touches OOXML or any
 * other wire format.
 */
export interface ExportInput {
  /** The live document (or one parsed from a stored revision). */
  doc: PMNode;
  /** blockId → section anchor label (§A.2 …), from `anchorByBlockId`. */
  anchors: Map<string, string>;
  /** Review comments, for adapters that can carry them (e.g. Word comments). */
  comments: Comment[];
}

export interface ExportAdapter {
  /** Registry key, e.g. "markdown", "docx". */
  id: string;
  /** File extension without the dot. */
  ext: string;
  /** Human label for menus and save dialogs, e.g. "Word document". */
  label: string;
  /** Produce the file payload: text formats return a string, binary formats
   *  a Uint8Array. */
  export(input: ExportInput): Promise<Uint8Array | string>;
}

const registry = new Map<string, ExportAdapter>();

export function registerAdapter(adapter: ExportAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getAdapter(id: string): ExportAdapter | undefined {
  return registry.get(id);
}

export function listAdapters(): ExportAdapter[] {
  return [...registry.values()];
}

/** Adapter #1 — the existing canonical markdown serializer, registered to
 *  prove the seam. Sidecars stay off: an export is a clean document, not the
 *  persistence form. */
export const markdownAdapter: ExportAdapter = {
  id: "markdown",
  ext: "md",
  label: "Markdown",
  export({ doc }: ExportInput): Promise<Uint8Array | string> {
    return Promise.resolve(planDocToMarkdown(doc, { sidecars: false }));
  },
};

registerAdapter(markdownAdapter);
