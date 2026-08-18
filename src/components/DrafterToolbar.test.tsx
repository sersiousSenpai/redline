// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";

// The ribbon's own subscription, tested directly.
//
// `DrafterToolbar` used to have NO subscription: it relied on the host
// re-rendering on every ProseMirror transaction, and called
// `editor.isActive(...)` fifteen times from that render. The host stopped doing
// that (per-keystroke renders of a ~2,800-line tree were the literal jank), so
// this file is the thing that makes stopping it safe: if the ribbon ever loses
// its `useEditorState`, every assertion below fails.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  StubResizeObserver;

import { DrafterToolbar } from "./DrafterToolbar";
import { drafterExtensions } from "../editor/extensions/drafterExtensions";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let host: HTMLDivElement;
let root: Root;
let editorHost: HTMLDivElement;
let editor: Editor;

beforeEach(async () => {
  editorHost = document.createElement("div");
  document.body.appendChild(editorHost);
  editor = new Editor({
    element: editorHost,
    extensions: drafterExtensions({
      onLockedEdit: () => {},
      onInstruct: () => {},
    }),
    content: "<p>Ship auth</p>",
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(DrafterToolbar, {
        editor,
        // The never-hidden three are prop-conditional — the host wires them.
        onSetSuggesting: () => {},
        onGenerate: () => {},
        onToggleSidecar: () => {},
      }),
    );
  });
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  editor.destroy();
  editorHost.remove();
  vi.clearAllMocks();
});

/** A ribbon button by the prefix of its accessible name. */
const btn = (prefix: string) =>
  [...host.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-label")?.startsWith(prefix),
  ) as HTMLButtonElement | undefined;

const pressed = (prefix: string) => btn(prefix)?.getAttribute("aria-pressed");

describe("DrafterToolbar tracks the editor without the host re-rendering", () => {
  it("reflects every inline mark as it toggles", async () => {
    for (const [name, run] of [
      ["Bold", () => editor.chain().selectAll().toggleBold().run()],
      ["Italic", () => editor.chain().selectAll().toggleItalic().run()],
      ["Underline", () => editor.chain().selectAll().toggleUnderline().run()],
      ["Strikethrough", () => editor.chain().selectAll().toggleStrike().run()],
    ] as const) {
      expect(pressed(name), `${name} started active`).toBe("false");
      await act(async () => {
        run();
      });
      await flush();
      expect(pressed(name), `${name} never lit up`).toBe("true");
      await act(async () => {
        run();
      });
      await flush();
      expect(pressed(name), `${name} never went out`).toBe("false");
    }
  });

  it("tracks the paragraph style as the caret's block changes", async () => {
    const label = () =>
      host.querySelector(".rl-ribbon-trigger-label")?.textContent;
    expect(label()).toBe("Normal");
    await act(async () => {
      editor.chain().focus().setHeading({ level: 2 }).run();
    });
    await flush();
    expect(label(), "the style dropdown stopped tracking the caret").toBe(
      "Heading 2",
    );
  });

  it("tracks alignment", async () => {
    expect(pressed("Align center")).toBe("false");
    await act(async () => {
      editor.chain().focus().setTextAlign("center").run();
    });
    await flush();
    expect(pressed("Align center")).toBe("true");
  });

  it("re-enables Undo once there is something to undo", async () => {
    // `editor.can().undo()` is read through the same subscription; without it
    // Undo would sit permanently disabled after the first mount.
    expect(btn("Undo")?.disabled).toBe(true);
    await act(async () => {
      editor.chain().focus().insertContent(" more").run();
    });
    await flush();
    expect(btn("Undo")?.disabled).toBe(false);
  });
});

describe("DrafterToolbar — the controls that never leave", () => {
  it("keeps Editing/Suggesting, ✦ and Comments mounted", () => {
    // The never-hidden set from lib/ribbonFit.ts, in the DOM. These are the
    // only controls with no keyboard equivalent and no other entry point, and
    // two of them govern whether your keystrokes are being tracked.
    for (const id of ["mode", "generate", "comments"]) {
      expect(
        host.querySelector(`[data-group="${id}"]`),
        `the ${id} group is not in the ribbon at all`,
      ).not.toBeNull();
    }
  });

  it("tags every group so the overflow law can address it", () => {
    const groups = [...host.querySelectorAll("[data-group]")].map(
      (g) => (g as HTMLElement).dataset.group,
    );
    // An untagged group can never be given up — it would just wrap.
    expect(groups).toContain("style");
    expect(groups).toContain("type");
    expect(groups.filter(Boolean).length).toBe(groups.length);
  });
});
