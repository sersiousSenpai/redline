// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Document, Packer } from "docx";

import type { ExportAdapter, ExportInput } from "../index";
import { registerAdapter } from "../index";
import { docToDocxChildren, orderedNumberingConfig } from "./nodeToDocx";

/**
 * Born-in-app `.docx` export — adapter #2 behind the format socket. Walks the
 * ProseMirror document into `docx` primitives (see nodeToDocx.ts) and packs a
 * Word file. Nothing outside this directory touches OOXML.
 */
export const docxAdapter: ExportAdapter = {
  id: "docx",
  ext: "docx",
  label: "Word document",
  async export({ doc }: ExportInput): Promise<Uint8Array> {
    const document = new Document({
      creator: "Redline",
      numbering: orderedNumberingConfig(),
      sections: [{ children: docToDocxChildren(doc) }],
    });
    // Base64 is the one Packer output that behaves identically in the WebView
    // and vitest's jsdom (whose Blob lacks arrayBuffer()).
    const b64 = await Packer.toBase64String(document);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  },
};

registerAdapter(docxAdapter);
