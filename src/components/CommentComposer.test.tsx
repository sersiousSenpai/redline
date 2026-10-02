// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { CommentComposer } from "./CommentComposer";
import type { CommentType } from "../types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(type: CommentType, onSubmit = vi.fn((_req: unknown, _opts: { discuss: boolean }) => Promise.resolve())) {
  await act(async () => {
    root.render(
      createElement(CommentComposer, {
        type,
        sessionId: "s",
        anchorId: "A.1",
        selectedText: "the old words",
        charStart: 0,
        charEnd: 13,
        onCancel: () => {},
        onSubmit,
      }),
    );
  });
  return onSubmit;
}

async function typeInto(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const press = (opts: KeyboardEventInit) =>
  act(async () => {
    host.firstElementChild!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...opts }));
  });

describe("CommentComposer — Send vs Save only", () => {
  it.each(["question", "feedback"] as const)("%s: ⌘⏎ sends (save + discuss)", async (type) => {
    const onSubmit = await mount(type);
    await typeInto(host.querySelector("textarea")!, "Why this order?");
    await press({ metaKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][1]).toEqual({ discuss: true });
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Send")).toBe(true);
  });

  it.each(["question", "feedback"] as const)("%s: ⌥⌘⏎ and the link save only", async (type) => {
    const onSubmit = await mount(type);
    await typeInto(host.querySelector("textarea")!, "Batch this one");
    await press({ metaKey: true, altKey: true });
    expect(onSubmit.mock.calls[0][1]).toEqual({ discuss: false });
    const saveOnly = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save only")!;
    await act(async () => saveOnly.click());
    expect(onSubmit.mock.calls[1][1]).toEqual({ discuss: false });
  });

  it("an edit just saves — the edit is the whole message", async () => {
    const onSubmit = await mount("edit");
    const areas = host.querySelectorAll("textarea");
    await typeInto(areas[0], "the new words");
    await press({ metaKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][1]).toEqual({ discuss: false });
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Save");
    expect(labels).not.toContain("Send");
    expect(labels).not.toContain("Save only");
  });
});
