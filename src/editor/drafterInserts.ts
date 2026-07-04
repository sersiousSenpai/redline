// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Editor } from "@tiptap/core";

// The commit half of the ribbon's Link and Footnote controls. The input
// popover lives in DrafterToolbar; these helpers carry the editor semantics
// so they can be exercised against a headless editor.

/** Apply a link URL to the current selection; an empty URL removes the link. */
export function applyLink(editor: Editor, url: string): void {
  if (url === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}

/** Insert a footnote at the caret, or update the one currently selected. */
export function applyFootnote(editor: Editor, text: string): void {
  if (editor.isActive("footnote")) {
    editor.chain().focus().updateFootnote(text).run();
  } else {
    editor.chain().focus().insertFootnote(text).run();
  }
}
