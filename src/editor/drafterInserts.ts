// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Editor } from "@tiptap/core";

// The commit half of the ribbon's Link control. The input popover lives in
// DrafterToolbar; this helper carries the editor semantics so it can be
// exercised against a headless editor.

/** Apply a link URL to the current selection; an empty URL removes the link. */
export function applyLink(editor: Editor, url: string): void {
  if (url === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}
