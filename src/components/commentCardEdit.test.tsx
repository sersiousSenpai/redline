// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Editing a draft comment in place. Save closes the editor at once, but the
// card's `comment` prop only changes when the comments-changed reload lands a
// beat later — the card must keep showing what was just saved in between,
// instead of flashing the old text back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { Comment, UpdateCommentRequest } from "../types";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { CommentCard } from "./CommentCard";

const draft: Comment = {
  id: "c-001",
  type: "feedback",
  anchorId: "A.1",
  body: "old words",
  createdAt: 1,
  status: "draft",
};

const edit: Comment = {
  ...draft,
  id: "c-002",
  type: "edit",
  body: "(edit)",
  edit: { original: "the cache", revised: "a cache" },
};

let host: HTMLDivElement;
let root: Root;

const text = () => host.textContent ?? "";

function render(comment: Comment, onUpdate: (id: string, u: UpdateCommentRequest) => void | Promise<boolean>) {
  return act(async () => {
    root.render(
      createElement(CommentCard, {
        comment,
        sessionId: "s-1",
        onDelete: () => {},
        onUpdate,
        onAccept: () => {},
        onReopen: () => {},
        onPromote: () => {},
      }),
    );
  });
}

function setField(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function editAndSave(fields: string[]) {
  await act(async () => host.querySelector<HTMLButtonElement>('[title="Edit draft comment"]')!.click());
  const areas = [...host.querySelectorAll("textarea")];
  await act(async () => {
    fields.forEach((value, i) => setField(areas[i], value));
  });
  const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
  await act(async () => save.click());
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  invokeMock.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "get_thread" ? [] : cmd === "fork_thread_model" ? [null, null] : null),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("CommentCard keeps a saved edit on screen until the reload lands", () => {
  it("shows the new body the moment Save is pressed, and through the reload", async () => {
    const onUpdate = vi.fn(() => Promise.resolve(true));
    await render(draft, onUpdate);
    await editAndSave(["new words"]);
    expect(onUpdate).toHaveBeenCalledWith("c-001", { body: "new words" });
    // The prop still carries the old text — the reload hasn't landed.
    expect(text()).toContain("new words");
    expect(text()).not.toContain("old words");
    // The reload: the prop catches up, and nothing changes on screen.
    await render({ ...draft, body: "new words" }, onUpdate);
    expect(text()).toContain("new words");
    expect(text()).not.toContain("old words");
  });

  it("shows a saved revised text for an edit comment before the reload", async () => {
    const onUpdate = vi.fn(() => Promise.resolve(true));
    await render(edit, onUpdate);
    await editAndSave(["the one cache", ""]);
    expect(text()).toContain("one");
    expect(text()).not.toContain("a cache");
  });

  it("puts the saved text back when the update did not land", async () => {
    const onUpdate = vi.fn(() => Promise.resolve(false));
    await render(draft, onUpdate);
    await editAndSave(["new words"]);
    expect(text()).toContain("old words");
    expect(text()).not.toContain("new words");
  });

  it("yields to a different change of the comment's text", async () => {
    const onUpdate = vi.fn(() => Promise.resolve(true));
    await render(draft, onUpdate);
    await editAndSave(["new words"]);
    // Someone else's write won the race; the prop is the truth again.
    await render({ ...draft, body: "their words" }, onUpdate);
    expect(text()).toContain("their words");
    expect(text()).not.toContain("new words");
  });
});
