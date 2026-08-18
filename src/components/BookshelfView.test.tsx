// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// Deleting the open document used to leave it in the drafter's open set — the
// row was gone from the database but the tab stayed, the documents menu still
// listed it, and the mount effect reopened it as a zombie pointing at nothing.
// `onCloseDoc` existed, was threaded, and was already called by the nested
// DocumentsMenu; `confirmDelete` simply never called it.

const SHELF = {
  folders: [],
  drafts: [
    {
      draftId: "d1",
      title: "Ship auth",
      folderId: null,
      projectPath: null,
      updatedAt: 1,
      isTemplate: false,
      openCount: 1,
      lastOpenedAt: 1,
    },
  ],
};

const IMPACT = {
  drafts: 1,
  folders: 0,
  comments: 0,
  pendingSuggestions: 0,
  sources: 0,
  chatMessages: 0,
};

const invoked: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    invoked.push(cmd);
    if (cmd === "bookshelf_list") return Promise.resolve(SHELF);
    if (cmd === "bookshelf_draft_impact") return Promise.resolve(IMPACT);
    return Promise.resolve(null);
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { BookshelfView, describeImpact } from "./BookshelfView";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invoked.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

/** Find a button by its accessible name or title. */
const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("title") === name ||
      b.getAttribute("aria-label") === name ||
      b.textContent?.trim() === name,
  );

describe("BookshelfView — deleting the open document", () => {
  it("closes it in the drafter, not just in the database", async () => {
    const onCloseDoc = vi.fn();
    await act(async () => {
      root.render(
        createElement(BookshelfView, {
          openDraftId: "d1",
          openIds: ["d1"],
          onOpen: () => {},
          onCloseDoc,
          onClose: () => {},
        }),
      );
    });
    await flush();

    button("Delete this document")?.click();
    await flush();

    // The confirm names what will go and requires the typed name.
    const input = host.querySelector("input") as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "Ship auth");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    const confirm = button("Delete") ?? button("Delete forever");
    expect(confirm, "the confirm button never appeared").toBeDefined();
    await act(async () => {
      confirm?.click();
    });
    await flush();

    expect(invoked).toContain("bookshelf_delete_draft");
    expect(
      onCloseDoc,
      "the row was deleted but the document stayed open — a zombie tab",
    ).toHaveBeenCalledWith("d1");
  });
});

describe("BookshelfView — no native dialogs", () => {
  it("never calls window.prompt, which WKWebView answers with a silent null", async () => {
    // Three features were dead in the packaged app because of this: creating a
    // folder, renaming a folder, and renaming a document. Click, nothing
    // happens, no error.
    const spy = vi.spyOn(window, "prompt");
    await act(async () => {
      root.render(
        createElement(BookshelfView, {
          openDraftId: "d1",
          openIds: ["d1"],
          onOpen: () => {},
          onClose: () => {},
        }),
      );
    });
    await flush();

    await act(async () => {
      button("Rename this document")?.click();
    });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    // ...and a real, focusable input appeared in its place. Portalled to the
    // body (the shelf scrolls, and a fixed child of a scrolled subtree is
    // positioned against that subtree — see popover.tsx).
    const input = document.body.querySelector<HTMLInputElement>(
      '[role="dialog"] input',
    );
    expect(input, "no naming popover appeared").not.toBeNull();
    expect(input?.value).toBe("Ship auth");
    spy.mockRestore();
  });
});

describe("describeImpact", () => {
  it("names exactly what a delete would destroy", () => {
    expect(describeImpact(IMPACT)).toBe("1 document");
    expect(
      describeImpact({ ...IMPACT, comments: 2, sources: 1, chatMessages: 3 }),
    ).toBe("1 document, 2 comments, 1 source, 3 discussion messages");
  });

  it("says 'nothing' rather than an empty string", () => {
    expect(describeImpact({ ...IMPACT, drafts: 0 })).toBe("nothing");
  });
});
